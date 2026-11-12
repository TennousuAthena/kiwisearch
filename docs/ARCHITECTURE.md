# 架构说明

这份文档讲 Kiwi Search 是怎么搭起来的：有哪些部分，一次搜索从头到尾怎么走，数据去了哪里。设计理由和各阶段的完成状态在 [PLAN.md](PLAN.md)，怎么构建和调试在 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 1. 总览

整个系统在用户自己的电脑上，没有 Kiwi 的服务器。

```
                         ┌───────────────────────── 用户的浏览器 ─────────────────────────┐
                         │                                                                │
  新标签页 / 搜索页 ─port─┼─▶ background（Service Worker）                                  │
  设置页 ─ storage.local ─┼─▶   └─ runSearch（packages/core）                              │
                         │         ├─ API 来源 ──────────── fetch ───▶ OpenAlex、Exa、…    │
                         │         ├─ 浏览器引擎 ─ tabRenderer ─▶ 最小化窗口里的工作标签页   │
                         │         │                              ▲ 内容脚本读 DOM 并回传   │
                         │         ├─ 决策模型 / 聊天模型 ── fetch ─▶ 你配置的服务           │
                         │         └─ 屏蔽列表（storage.local）                             │
                         │                                                                │
                         │   MCP 桥客户端 ◀── WebSocket ──▶ 127.0.0.1:17345               │
                         └────────────────────────────────────────┬───────────────────────┘
                                                                  │
                                           packages/mcp（stdio MCP 服务）◀─ Claude Desktop / Cursor
```

三条原则决定了结构：

1. **浏览器的事只在扩展里做。** `packages/core` 是纯逻辑，从不调用 `browser.*`；调用方通过 `Env`（`fetch`、`cache`、`runBrowserEngine`、`loadBlocklists`）把浏览器的能力递给它。所以 core 的测试不需要浏览器。
2. **一次搜索用同一份配置快照。** 渲染器的设置跟着 `BrowserRunOptions` 走，搜索中途改设置不会让一次搜索前后不一致。
3. **进度用事件流表达。** 搜索页和 MCP 桥消费同一个 `PipelineEvent` 流，没有第二套逻辑。

## 2. 三个包

| 包 | 内容 | 依赖 |
|---|---|---|
| `packages/core` | 搜索管线：来源与引擎、去重融合、决策模型、屏蔽列表、重排、摘要。TypeScript 源码，不独立发布，扩展和 MCP 直接打进各自的包 | `node-html-parser`（解析页面） |
| `apps/extension` | WXT + React 的 Manifest V3 扩展：后台调度、新标签页、设置页、内容脚本 | `@kiwi-search/core`、React、`marked`、`dompurify` |
| `packages/mcp` | stdio MCP 服务，把工具调用转给浏览器里的扩展 | MCP SDK、`ws`、`zod` |
| `packages/experiments` | 离线评测的空壳（目前没有源码和测试，README 提到的 CLI 和报告不在仓库里） | |

### core 的模块

| 文件 | 职责 |
|---|---|
| `pipeline.ts` | `runSearch`：整个搜索流程（见第 3 节） |
| `types.ts` | 所有类型：`SearchMode`、`SourceId`、`FusionConfig`、`PipelineEvent`、`Env`…… |
| `config.ts` | 默认配置、`CONFIG_VERSION` 与迁移、`mergeConfig`、`usableSources`、每个模式取多少条 |
| `sources/` | 11 个 API 来源和注册表 `SOURCES` |
| `engines/` | 17 个浏览器引擎（`BrowserEngine`：拼网址、识别页面、提取结果） |
| `fusion.ts`、`url.ts` | URL 归一化、去重、RRF、论文与转载合并、应用重排分数 |
| `judge.ts` | 决策模型过滤与排序、域名规则（`applyDomainRules`）、正文提示注入检查 |
| `blocklist.ts` | 屏蔽列表：解析、匹配、推荐目录（见 [BLOCKLISTS.md](BLOCKLISTS.md)） |
| `decision.ts` | 决策模型提供方这一层：专用服务、聊天模型兜底（见 [DECISION-PROVIDERS.md](DECISION-PROVIDERS.md)） |
| `intent.ts` | 读搜索词判断要不要补搜别的平台、要不要建议换标签 |
| `academic.ts` | 智能学术搜索：解析模型给的检索计划、核对论文是否存在、二轮检索 |
| `summarize.ts`、`content.ts`、`llm.ts` | AI 概览：提示词与引用、抓正文、OpenAI 兼容的聊天调用 |
| `rerank.ts` | 没有决策模型时的备选重排（LLM、Jina、Cohere） |
| `cache.ts` | 来源结果缓存，5 分钟，按“模式/来源/条数/搜索词” |
| `http.ts`、`text.ts` | 带超时的请求和错误文字；网页转文字、截断 |

## 3. 一次搜索怎么走

`runSearch(query, config, env, { mode, sources, softDeadlineMs, summarize, limit, signal, onEvent })` 就是整个流程。

1. **选来源。** `usableSources` 按模式、开关、Key、是否有浏览器挑出能跑的来源；指定了 `sources` 就再取交集。一个也没有就报错。
2. **读屏蔽列表。** 和来源同时开始，不等它；读失败就当没有订阅名单，搜索照常进行。
3. **并行查询。** 每个来源有自己的超时：API 来源默认 15 秒；浏览器来源排队最多 60 秒，超时从它真正开始加载页面（`onStart`）才计时；被验证码或登录墙拦住（`source_blocked`）的来源超时放宽到 120 秒。命中缓存的来源立刻返回。
4. **渐进出结果。** 每个来源完成就发一次 `fused`（`partial: true`），所以页面不用等最慢的。设了 `softDeadlineMs`（新标签页用 6 秒，MCP 不设）时，到点就停止等待：慢的来源继续跑，结果之后以 `late_results` 并入。如果到点时一个来源都没回来，就继续等第一个有结果的；如果要写概览而已到的来源都没有文字（比如 DuckDuckGo 的结果不带摘要），就继续等第一个有文字的，否则这次搜索就没有概览了。
5. **按意图补搜**（`web` 模式、没指定来源、决策模型可用）：通用来源已经在跑的同时，决策模型读搜索词，回答六个是非题（学术？知乎？小红书？公众号？图片？视频？）。概率不低于 `intent.threshold`（0.6）的路线，在搜索进行到一半时启动对应来源，各按自己的模式生成网址、共用自己的缓存，并入同一次融合；`routed` 事件报告判定。没有可用模型、出错、超时（默认 8 秒）都只是不补搜。判定同时会给出 `suggest`：图片、视频、学术里最像的一个，达到 `switchThreshold`（0.85）且开了自动切换时页面会自己移到那个标签，否则只提示一行。
6. **智能学术搜索**（`academic` 模式、没指定来源、`academic.smart` 开着、有可用的聊天模型）：来源在跑的同时，你自己的模型读查询，给出理解、关键词、各 API 来源的检索式和最多 5 篇代表论文。论文逐篇到 OpenAlex（关了就用 Crossref）核对，**查不到的丢掉**，所以模型凭记忆编出来的论文不会上页面。核对过的论文排在融合最前，之后是二轮检索（模型的检索式，加一轮 OpenAlex 按被引排序）。浏览器来源不做二轮，免得多开标签、多碰验证码。整个计划受 `academic.timeoutMs`（12 秒）约束，即使过了软截止时间也会等它。
7. **融合与域名规则。** `fuse`：URL 归一化去重、RRF、论文与转载合并（见第 4 节），然后 `applyDomainRules`：你的屏蔽与优先网站、屏蔽列表（见 [BLOCKLISTS.md](BLOCKLISTS.md)）。这一步在部分结果上也做。
8. **决策模型过滤**（文字类模式、模型可用）：取前 `judge.candidates`（30）条未隐藏的结果，每条得到相关度、垃圾概率和每条自定义规则的概率。排序分 = (0.75 × 相关度 + 0.25 × RRF 先验) × (1 − 0.5 × 垃圾概率)，优先网站再乘 1.25。垃圾或规则概率 ≥ 0.7、归一化相关度 < 0.2 的隐藏（折叠）；主列表至少留 3 条。启用时取代重排。事件 `judged`。没有可用的决策模型时可选 `reranked`。
9. **AI 概览**（文字类模式、开了概览、有摘要模型）：取前几条未隐藏的结果，读正文（`content.ts`；知乎、小红书不抓，用它们自己的摘录），决策模型可用时先检查正文有没有针对摘要模型的指令，有就不用那一页；然后流式生成带 `[n]` 引用的概览（`summary_start`、`summary_prompt`、`summary_delta`、`summary_done` 或 `summary_error`）。提示词把所有来源声明为不可信数据；混着平台帖子和普通网页时，要求按平台说明差异。**概览只在软截止时间到点那一刻决定要不要写，晚到的结果不会触发。**
10. **结束。** `done` 带完整的 `PipelineResult`（结果、引用、各来源统计、学术计划）。之后晚到的来源逐个发 `late_results`：先过域名规则，决策模型可用时先判定再并入，一次一个。

**哪些模式有概览和过滤**：`modeHasText`（`web`、`academic`、`zhihu`、`wechat`）为真的才有。图片、视频、小红书笔记、X 的推文是媒体或社交卡片，不判定也不概览。扩展页面里有一个同名的 `modeHasOverview`，因为页面包不该把 core 整个引进来（会带上所有解析器）。

### 事件

| 事件 | 含义 |
|---|---|
| `source_start`、`source_done`、`source_error` | 一个来源开始、完成（带条数和耗时）、出错 |
| `source_blocked` | 来源碰到验证码（`captcha`）或登录墙（`login`） |
| `fused` | 融合后的结果；`partial` 为真表示还有来源没回来 |
| `routed`、`academic_plan` | 意图判定的结果、学术计划（理解、检索式、核对过的论文，或错误） |
| `judged`、`reranked` | 过滤后的结果，或重排后的结果；失败时带 `error`，页面状态行说原因 |
| `summary_*` | 概览的生成过程 |
| `late_results` | 软截止时间后或被拦住的来源并进来的结果 |
| `done` | 这次搜索完成 |

## 4. 去重与融合

- **URL 归一化**（`url.ts`）：去跟踪参数（`utm_*`、`gclid`、`msockid`…），去 `www.` 和 `m.`，去结尾斜杠和 `index.html`。有专门的键：DOI（也能从出版社网址里取）、arXiv ID、YouTube 视频 ID（`youtu.be`、Shorts、嵌入页同一个）、哔哩哔哩 BV 号（分 P 同一个）、小红书笔记 ID（国内站和 RedNote 的同一条合并成 `xhs:<id>`）。
- **论文**：DOI 相同、或 `meta.doi` 相同（PubMed、Europe PMC 链接自己的页面，靠这条与 OpenAlex、Crossref 合并），或“长标题加相容的年份”。
- **图片**：按图片文件本身。
- **转载**（`foldReprints`）：同一篇文章发在几个网站时折成一条，带 `reprints`。条件是标题相同（去掉 `_CSDN博客` 这类站名后缀，至少 12 个字符）、网站不同，并且各引擎给的摘要文字有重叠；保留不在转载站（`REPRINT_HOSTS`）上的那份，再取最早的日期、最好的排名。论文、图片、视频、笔记不折。哪份是原文只是猜测，所以页面只写“同一篇还出现在 …”。
- **RRF**：倒数排名融合，每个来源有可调的权重（设置页“高级”里）。

## 5. 来源体系

所有来源统一成 `SearchSource`，登记在 `sources/index.ts` 的 `SOURCES` 里（类型是 `Record<SourceId, …>`，漏登记 TypeScript 会报错）。每个来源声明自己支持的模式、要不要 Key、要不要自己的服务地址、要不要浏览器。

- **API 来源**（`sources/*.ts`）：`brave`、`exa`、`deepseek`、`openalex`、`crossref`、`arxiv`、`openverse`、`pubmed`、`europepmc`、`dblp`、`searxng`。通过 `env.fetch` 请求。
- **浏览器引擎**（`engines/*.ts`）：`google`、`bing`、`baidu`、`duckduckgo`、`scholar`、`baiduxueshu`、`cnki`、`wos`、`yandex`、`youtube`、`bilibili`、`zhihu`、`xiaohongshu`、`rednote`、`sogou`、`weixin`、`x`。每个是一个 `BrowserEngine`：
  - `buildUrl(query, count, mode)` 拼出结果页网址；`matches` 说明内容脚本该在哪些网址上工作；
  - `readySelector` 表示结果开始渲染（可以覆盖多个模式）；`blockedSelector` / `isBlockedUrl` 识别验证码；`loginSelector` / `isLoginUrl` 识别登录墙；`refusedPattern` 识别网站明确拒绝（如知乎的风控 JSON）；
  - `extract(doc, pageUrl, mode)` 把页面读成 `SearchHit`；`resolve` 可选，用来拆开跳转链接；`minIntervalMs` 可选，比全局间隔更长的请求间隔（X 是 10 秒）。
  - `makeBrowserSource`（`engines/shared.ts`）把引擎包装成来源。Bing 的网页和图片共用一个工作标签页和一条队列，因为搜索引擎的风控按站点算。
- 各来源的细节（YouTube 读页面内联的 `ytInitialData`、搜狗的跳转链接、PubMed 两步请求……）和它们的验证情况见 [CLAUDE.md](../CLAUDE.md) 与 [PLAN.md](PLAN.md) 第 8 节。

## 6. 浏览器渲染

浏览器引擎的结果来自真实的搜索结果页，这是扩展里唯一碰浏览器标签页的部分（`apps/extension/lib/tabRenderer.ts` 加内容脚本 `entrypoints/engines.content.ts`）。

- **工作窗口**：所有工作标签页放在一个专用的窗口里，创建后立刻最小化（macOS 的 Chromium 会忽略创建时的 `minimized`，所以要再显式更新一次），窗口里是一个标题为“Kiwi Search”的灰色标签组。窗口被你关掉会自动重建。状态存在 `chrome.storage.session` 的 `kiwiRenderer` 下。
- **队列与限速**：每个来源一条串行队列，两次请求至少间隔 `renderer.minIntervalMs`（3 秒）；X 再加 `minIntervalMs` 的 10 秒。每个来源一个固定的工作标签页，闲置超过 `renderer.workerIdleMinutes`（10 分钟）由每分钟一次的闹钟回收。
- **握手**：内容脚本注入到引擎的结果页（匹配范围来自 `BROWSER_ENGINES`）后，先向后台问“我是工作标签页吗”（`kiwi:worker?`），只有被登记的工作标签页才会收到 `kiwi:worker!`（带这次请求的条数和模式）并开始工作；别的页面收到 `kiwi:not-worker`，什么也不做，所以你自己打开这些网站不受影响。
- **提取时机**：脚本监听页面变化，等到 `readySelector` 出现再提取；拿够条数立刻返回，不够就等页面安静 600 毫秒，12 秒超时也交出手上已有的，不返回空。结果用 `kiwi:extracted` 回传。
- **被拦住或被拒绝**：碰到验证码或登录墙，脚本发 `kiwi:blocked`（带 `reason`）；管线把这个来源标为 `blocked`，页面显示一行安静的提示（“去验证”或“去登录”）。只有你点了，工作窗口才会被调到前台（`kiwi:focus-worker`）；开启“遇到验证码时自动弹出”（默认关）才会自己弹，而且只对验证码。网站明确拒绝（`kiwi:refused`）和页面加载完 4 秒内内容脚本没打招呼（浏览器的错误页、一个被 403 的页面、跳到了引擎不读的页面）都会快速失败，不会等满超时。
- 这部分没有自动化测试，需要在真实浏览器里验证（见 [DEVELOPMENT.md](DEVELOPMENT.md)）。

## 7. 决策模型

决策模型回答搜索里的小问题：这条结果和搜索相关吗？是不是内容农场？这个查询是不是学术问题？它是一层提供方，不绑定任何一家：专用的小模型（默认预设是 TypeSafe 的 Jev，协议叫 System One；地址、Key、模型都能改，本机服务可以不要 Key），或者用户自己的 OpenAI 兼容聊天模型。没配专用的、或它明确拒绝时（4xx 里除了 408 和 429，或连不上；超时、429、5xx 不算），聊天模型兜底，可以关。所有问题都经 `askDecision`，拿回 System One 形状的答案，所以阈值、隐藏、路由对每个提供方都一样。聊天模型这条路径把问题放进一次 JSON 请求，结果十条一批、三批并行。协议、各种情形和接入方法见 [DECISION-PROVIDERS.md](DECISION-PROVIDERS.md)。

## 8. 配置与存储

**配置**是一个 `FusionConfig`，存在 `chrome.storage.local` 的 `config` 键下，带 `version`（当前 `CONFIG_VERSION = 5`）。读取时先 `migrateConfig`（`MIGRATIONS[n]` 把版本 n 升到 n+1，用来改写已保存的值，比如把旧的默认值换成新的），再用 `mergeConfig` 深度合并到 `DEFAULT_CONFIG` 上。所以**新增字段只需要在 `config.ts` 里给默认值**；只有要改写用户已存的值时才需要迁移。

主要字段的默认值：

| 字段 | 默认 |
|---|---|
| `perSourceCount` / `imageCount` / `videoCount` / `noteCount` | 10 / 40 / 16 / 12 |
| `sourceTimeoutMs` | 15000 |
| `renderer` | 间隔 3000 毫秒，闲置 10 分钟回收，验证码不自动弹出 |
| `judge` | 提供方 `systemone`，兜底聊天模型开，候选 30，隐藏阈值 0.7，相关度下限 0.2，权重 0.75，超时 12 秒；屏蔽、优先网站和屏蔽列表默认为空 |
| `intent` | 开，阈值 0.6，自动切换阈值 0.85，超时 8 秒 |
| `academic` | 智能搜索开，超时 12 秒，最多点名 5 篇 |
| `summary` | 开，提供方 `api`，引用前 8 条，读正文方式 `direct`，每条最多 3000 字 |
| `rerank` | 关 |

**存储键**（`chrome.storage.local`，除非另注）：

| 键 | 内容 |
|---|---|
| `config` | 上面的配置，包括各来源的 Key 和屏蔽列表设置 |
| `bridge` | MCP 桥：是否启用、端口、配对令牌 |
| `onboarding` | “开始使用”引导是否完成 |
| `sourceStatus` | 每个来源上一次真实搜索的结果（正常、没结果、要登录、要验证、出错），设置页显示 |
| `blocklistMeta`、`blocklist:<id>` | 订阅名单的状态和解析好的规则 |
| `favicon:<host>` | 网站图标缓存（命中 7 天，没找到 6 小时；超过 500 条时修剪到 400 条） |
| `kiwiRenderer`（`storage.session`） | 工作窗口和工作标签页的状态 |

**Key 存在哪**：和其他设置一样，明文存在 `chrome.storage.local`，只在你自己的浏览器配置文件里。

## 9. 扩展

`apps/extension` 有四类入口：

- **`background.ts`**（Service Worker）：运行 `runSearch`。搜索页通过 `runtime.connect({ name: 'search' })` 打开一个端口，发 `search` 请求（`query`、`mode`），收到流式的 `PortMessage`（`event` 或 `fatal`）；有来源被拦住或晚到时，端口会一直开到它们结束。同一个文件还注册了：地址栏关键词 `k`；一条 declarativeNetRequest 规则，把 `https://s.kiwi.moe/s?…` 重定向到扩展自己的搜索页；`kiwi:*` 消息（`favicon`、`test-llm`、`test-decision`、`blocklist-refresh`，以及渲染器用的 `worker?`、`extracted`、`blocked`、`refused`、`focus-worker`）；屏蔽列表的刷新（启动时、每 6 小时的闹钟、订阅变化时）；MCP 桥的重连闹钟（每 30 秒）。
- **`newtab/`**：搜索页。`lib/useSearchSession.ts` 管端口、保活和浏览器内置模型的概览；`lib/searchState.ts` 是把 `PipelineEvent` 折成页面状态的纯 reducer；`lib/results.ts`、`lib/justify.ts` 是纯函数。组件按模式分：结果列表、图片网格、笔记墙、概览、学术计划与核心文献、“各平台怎么说”（`PlatformStrip`）、引擎小图标（`SourceMarks`）、标签（`ModeTabs`，知乎、小红书、公众号、X 收在“社区”下）。地址形如 `newtab.html?q=…&m=images`，新搜索用 `pushState`。
- **`options/`**：设置页，以整页标签打开。改动由 `useAutosave` 自动保存；来源按内容类型分组（`lib/sourceCatalog.ts`），每个来源显示 `sourceStatus` 里记的状态（`lib/sourceView.ts`）；各种“测试连接”发 `kiwi:test-llm` 或 `kiwi:test-decision` 给后台。
- **`engines.content.ts`**：内容脚本，见第 6 节。

**网站图标**（`lib/faviconService.ts`）：先问浏览器自己的 `_favicon`（只有访问过或加了书签的站点才有真图标，其他都是同一个占位地球，靠和一个编造域名的回答比较来识别），再请求站点自己的 `/favicon.ico` 和首页的 `<link rel="icon">`（不带 Cookie 和 Referer，只对公开域名，靠文件头判断是不是图片），最后是字母徽标。至多 4 个站点请求并行。代价是你没访问过的网站，在它出现在结果里时会收到一次图标请求；没有第三方图标服务看到你的结果。

**引擎小图标**：只在被两个或更多引擎收录的结果上，用各品牌的真 logo（`assets/engine-logos/`，出处和许可在 `logos.json` 和 `NOTICE.md`；`scripts/gen-source-icons.mjs` 把它们转成数据 URI，所以不需要联网）显示在站点名后面。除此之外，页面上只在验证码提示里提到来源。

## 10. MCP 桥

```
Claude Desktop / Cursor ──stdio──▶ MCP 进程（hub 或 relay）──WebSocket──▶ 浏览器里的扩展
```

- **配对**：MCP 进程首次运行时，在 `~/.kiwi-search/token`（`KIWI_HOME` 可改目录）生成令牌，权限 `0600`；扩展连接时必须出示令牌，且来源是 `chrome-extension://`（设了 `KIWI_EXTENSION_ID` 还要匹配 ID）。只监听 `127.0.0.1`。
- **hub 与 relay**（`BridgeSession`）：第一个 MCP 进程绑定 `127.0.0.1:17345`（`KIWI_PORT`）成为 hub，它接受扩展（`/extension`）和后来的 MCP 进程（`/mcp`）；后来的进程拿到 `EADDRINUSE`，就当 relay，通过 hub 转发。所以一个浏览器连接能同时服务多个 MCP 客户端；hub 进程退出时，relay 随机延迟后抢占端口接管。hub 会重映射请求 ID。
- **扩展一侧**（`lib/bridge.ts`）：用 WebSocket 连 hub（WebSocket 流量能让 Service Worker 保持存活，每 20 秒一个 ping），握手时带上来源的可用状态；每个请求都走同一个 `runSearch`，所以和页面共用队列、限速、缓存和工作标签页。
- **工具**：`search`、`answer`、`list_sources`（参数见 [README](../README.md)）。被过滤的结果不进列表，放在 `structuredContent.hidden`。`answer` 在摘要提供方是 `chrome-builtin` 时不可用，因为那个模型只能在搜索页里运行。

## 11. 数据去了哪里

没有 Kiwi 的服务器，下面每一项都是你的浏览器直接发出的：

| 数据 | 发给谁 | 什么时候 |
|---|---|---|
| 搜索词 | 你启用的每个来源：浏览器引擎是在你的浏览器里打开那家网站的结果页，API 来源是它的 API | 每次搜索 |
| 搜索词、每条结果的标题和网址和摘要 | 决策模型服务（专用的，或兜底时你的 AI 模型） | 决策模型可用时，文字类模式（网页、学术、知乎、公众号）的每次搜索；“全部”模式还会多一次只带搜索词的意图判定。没有可用的决策模型就不发 |
| 搜索词、前几条结果的正文片段 | 你的 AI 模型（概览） | 开了概览且配了模型 |
| 前几条结果的网址 | 结果所在的网站（读正文，`direct`）；或 Jina（选了 `jina` 时） | 读正文时；知乎、小红书不读 |
| 搜索词；模型点名的论文标题 | 你的 AI 模型；OpenAlex 或 Crossref | 智能学术搜索 |
| 结果里出现的域名 | 那个站点（取图标） | 站点第一次出现，之后 7 天内用缓存 |
| 对名单文件的请求（没有 Cookie、Referer、搜索内容） | 名单所在的主机 | 订阅了屏蔽列表，每天最多一次 |
| 配对令牌和搜索请求 | `127.0.0.1` 上的 MCP 进程 | 开了 MCP 桥 |

Kiwi 不会把这些数据发给自己的服务器，也不提供账号、Key 或代理。
