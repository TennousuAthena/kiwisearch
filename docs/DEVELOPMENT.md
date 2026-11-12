# 开发指南

怎么把项目跑起来、怎么测、怎么在真实浏览器里验证、怎么加东西，以及已经踩过的坑。整体结构看 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 环境与命令

需要 Node.js 24 和 pnpm 12。pnpm 工作区，命令都从仓库根目录运行。

```sh
pnpm install
```

`pnpm install` 会触发扩展的 `postinstall`（`wxt prepare`），生成 `apps/extension/.wxt/`。`apps/extension/tsconfig.json` 继承这个生成的文件，所以没装过依赖就跑类型检查会失败。

| 做什么 | 命令 |
|---|---|
| 测某个包 | `pnpm --filter @kiwi-search/core test`（换成 `@kiwi-search/extension`、`@kiwi-search/mcp`） |
| 只跑一个测试文件 | `pnpm --filter @kiwi-search/core exec vitest run test/fusion.test.ts` |
| 只跑一个用例 | 在上面加 `-t "<用例名>"` |
| 类型检查 | `pnpm typecheck`（各包 `tsc`；扩展先跑 `wxt prepare`） |
| 构建 Chrome 扩展 | `pnpm --filter @kiwi-search/extension build`，输出 `apps/extension/.output/chrome-mv3`，加载为未打包扩展 |
| 构建 Firefox 扩展 | `pnpm --filter @kiwi-search/extension build:firefox`（目前输出 MV2；Firefox 没有实际测过） |
| 开发服务器 | `pnpm dev` |
| 构建 MCP 服务 | `pnpm --filter @kiwi-search/mcp build`，输出 `packages/mcp/dist/index.js` |

**没有 lint 脚本和 lint 配置，类型检查是唯一的静态检查。**

**根目录的 `pnpm test` 目前会失败**：它会跑到 `packages/experiments`，那个包只有一个空壳，没有测试文件，`vitest` 以“No test files found”退出。三个有测试的包请用上面的 `--filter` 分别跑。截至 2026-11-12，core 408 条、extension 104 条、mcp 14 条，全部通过。

## 仓库结构

```
apps/extension/            WXT + React，Manifest V3
  entrypoints/             background.ts、engines.content.ts、newtab/、options/
  lib/                     后台与页面共用的逻辑（渲染器、设置、来源状态、屏蔽列表、图标……）
  assets/engine-logos/     引擎小图标的 logo 文件，logos.json 记出处，NOTICE.md 记许可
  scripts/                 gen-source-icons.mjs：把 logo 转成 lib/sourceIcons.ts
  test/                    vitest：只测纯逻辑，不碰真实浏览器
packages/core/             搜索管线（src/）与测试（test/，夹具在 test/fixtures/）
packages/mcp/              stdio MCP 服务
packages/experiments/      离线评测的空壳
docs/                      本目录（中文，给人看）
docs/internals/            实现细节和验证记录（英文），按主题分文件
DESIGN.md                  界面设计
AGENTS.md                  给 AI 编码助手的入口说明（英文）：简介、命令、代码地图、文档索引、规则
CLAUDE.md                  只有一行 @AGENTS.md，让 Claude Code 读到 AGENTS.md
```

## 测试

**框架**：vitest。core 的测试用 `happy-dom` 解析保存下来的页面，不需要浏览器。

**夹具**：每个引擎的解析器测试用 `packages/core/test/fixtures/` 里保存的页面。引擎的页面结构变了，就更新它的 `extract` 并重新抓夹具。夹具分两类，要分清：

- **真实抓取**：`arxiv.xml`、`crossref.json`、`openverse.json`；`wikipedia-exa.json`（Exa 对中文各版本维基百科的两次真实搜索，只留地址和标题，共 50 条）；`youtube.html`（真实响应里的内联数据，裁剪过）、`bilibili.html`（渲染后的 DOM，前 12 张卡片）；`zhihu.html`、`rednote.html`（已登录浏览器里抓的，`xsec_token` 替换成了 `REDACTED`；`rednote.html` 里有一条“大家都在搜”推荐，用的是同样的卡片标记，不能当成结果）；`duckduckgo.html`（摘要在 `div[data-result="snippet"]`，测试要求每条结果都有摘要）；`bravesearch.html`（开发浏览器里读到的渲染后 DOM，20 条结果，脚本、样式、SVG 已去掉）和拦截页 `bravesearch-blocked.html`（冷启动无头 Chromium 拿到的滑块验证码页）；`weixin.html`（10 张卡片，`token=` 已隐去）、`sogou.html`（前 14 块）；`x.html`（已登录的 X 搜索，6 条推文，去掉了 svg、class 和 style）；`pubmed-esearch.json`、`pubmed-efetch.xml`（参考文献列表裁掉了）、`europepmc.json`、`europepmc-preprints.json`；`baiduxueshu.html`（10 张卡片）；拦截页 `baiduxueshu-blocked.html`、`cnki-blocked.html`、`wos-blocked.html`（脚本已去掉，验证码 key、令牌和客户端 IP 已隐去）；`dblp-challenge.html`（DBLP 的机器人验证页）；`blocklist-excerpts.txt`（从四个真实屏蔽列表里原样摘的行）。
- **手写**：`bing-images.html`（Bing 拒绝非浏览器客户端，所以只证明解析器匹配我们假设的结构）、`dblp.json`（当时 API 在机器人验证后面）、`cnki.html`、`wos.html`（前面有验证码或登录，进不去真实结果页）；X 长文（Article）的那条测试。手写的夹具在文件第一行或 `_note` 字段里自己说明，它们的测试只证明解析器和当初写它时的假设一致。
- `parsers.test.ts` 里的 `blockedUrl` 表，对于每个有真实 `<id>-blocked.html` 的引擎不需要登记。
- 有些选择器只是猜的，没见过真实页面，哪些见 [PLAN.md](PLAN.md) 第 8 节（Brave 网页的验证码页是真实抓的，不在其中）：搜狗验证码页（`/antispider`）、哔哩哔哩验证码（Geetest）、知乎的 `.SignFlow`、小红书的 `.login-container`、X 的 `loginButton` / `signupButton`。

**自动化测不到的**：标签渲染（`tabRenderer.ts`）和内容脚本。它们必须在真实浏览器里验证。

## 在真实浏览器里验证

### 一个绕不开的坑：同一路径的未打包扩展会一直跑旧的 Service Worker

重新构建后，浏览器里已经加载的未打包扩展，如果路径没变，会继续运行**旧的** `background.js`（清单是新的，脚本是旧的；`chrome.runtime.reload()` 会让扩展死掉；改副本里的版本号也没用）。可行的做法：

1. 每次构建后，把 `.output/chrome-mv3` **复制到一个全新的目录**，从这个新目录加载。
2. 新路径就是新的扩展 ID（未打包扩展的 ID 是它真实路径的 SHA-256 前 128 位，把每个十六进制数字换成 `a`–`p` 的字母），所以它的 `chrome.storage.local` 是空的：你填的 Key 和设置要搬过去或重新填。
3. 别信“我已经构建了”，要核对：用 DevTools 协议（CDP）在 Service Worker 上取 `Debugger.getScriptSource`，和磁盘上的构建文件比较。

### 有界面的开发浏览器

- 用一个**固定的配置文件目录**启动 Chromium：`--user-data-dir=<目录> --remote-debugging-port=<端口> --load-extension=<新副本>`。需要登录的平台（知乎、小红书、X）登录一次，登录状态存在这个目录里；**不要删它**，每次删都要重新扫码。
- 一个配置文件同一时间只能有一个浏览器进程。要换新版，通过 CDP 的 `Browser.close` 关掉（不会丢登录），不要去删锁文件。
- 不要给这些登录伪造 User-Agent，用真实的有界面浏览器。

### 无界面的端到端

适合不需要登录的流程（屏蔽列表就是这样验证的）：

```sh
chromium --headless=new --remote-debugging-port=9334 --user-data-dir=<临时目录> \
  --load-extension=<副本> --disable-extensions-except=<副本> --no-first-run about:blank
```

然后用 CDP 驱动：打开 `chrome-extension://<id>/options.html`，在页面里用 `chrome.storage.local.set({ config })` 写入配置；再打开 `newtab.html?q=…`，读页面上的结果。扩展 ID 可以从 `/json/list` 里 Service Worker 的网址取得。几条经验：

- **只开一个 API 来源**（比如 Exa）做端到端最省事：不需要浏览器引擎、工作窗口、登录，结果是真的、也快；页面上可见的结果是 `.result-list:not(.muted) article`，折叠区的按钮是 `.hidden-results .disclosure`（默认收起，点开后卡片才渲染）。
- 要测“下载别人的文件”的逻辑（屏蔽列表订阅），在本机起一个能控制响应的小服务：支持 `ETag`、可以故意返回 500、可以返回 HTML。localhost 的 `http://` 地址订阅是允许的。
- 往存储里写测试配置时要带 `version: <当前的 CONFIG_VERSION>`。不带的配置会被当成版本 1，依次跑所有迁移，其中有的会改你写的值（比如把百度关掉、把“需要人机验证时自动弹出验证窗口”关掉）。

### 不开扩展看新标签页

页面本身可以脱离扩展检查：把 `.output/chrome-mv3` 用静态服务器起来，注入一个模拟的 `window.chrome.runtime`，它的 `connect()` 返回的端口重放一串 `PipelineEvent`，再用无头 Chromium 通过 CDP 截图。

## 加一个新来源

加来源要改的地方比看起来多，漏一处通常 TypeScript 会提醒，但有一处不会（第 5 步）：

1. **`packages/core/src/types.ts`**：`SourceId` 联合类型（手写的）里加上 id。
2. **来源本身**：
   - API 来源：写 `sources/<id>.ts`（`SearchSource`，通过 `env.fetch` 请求），在 `sources/index.ts` 的 `SOURCES` 里登记。
   - 浏览器引擎：写 `engines/<id>.ts`（`BrowserEngine`），加进 `engines/index.ts` 的 `BROWSER_ENGINES`。百度要一直排在最后，`config.test.ts` 里有一条测试检查这一点。
3. **语言包**（`apps/extension/lib/i18n/catalog/`）：`source.label.<id>` 和 `source.blurb.<id>`（`options.ts`），`mark.<id>`（`newtab.ts`）。这些是按 `SourceId` 类型检查的动态键，漏一个 `tsc` 会报错。
4. **`apps/extension/lib/sourceMarks.ts`**：`SOURCE_MARKS`（`Record<SourceId, …>`），以及它的 logo：文件放进 `assets/engine-logos/`，在 `logos.json` 里登记出处，在 `NOTICE.md` 里写许可（`test/sourceMarks.test.ts` 要求两者都有），然后运行 `node apps/extension/scripts/gen-source-icons.mjs` 生成 `lib/sourceIcons.ts`。logo 必须是品牌真的 logo：先找 SVG Logos、Simple Icons 这类开放集合，没有就取品牌自己网站的图标；**不要自己画字母徽标**。
5. **`DEFAULT_CONFIG.sources`**（`config.ts`）：**这个字段是 `Partial`，缺了不会报错，来源会悄悄地默认关闭。**
6. **`apps/extension/lib/sourceCatalog.ts`**：`SOURCE_INFO`（设置页里的分组、是否需要登录、是否需要 Key、是否要确认才能开；一句话说明和确认的理由在语言包里）。
7. **测试**：浏览器引擎要有保存下来的真实页面作夹具；拿不到就手写，并在夹具第一行写明是手写的、依据是什么。同时在 [PLAN.md](PLAN.md) 和 [internals/](internals/) 里对应主题的文件中写清**哪些验证过、哪些没有**，这是这个项目的约定。

**界面文字不要写在组件里**，写进 `apps/extension/lib/i18n/catalog/`，用 `t()` 取，见 [I18N.md](I18N.md)。`test/noHardcodedText.test.ts` 会拦住写死的中文，`test/copyStyle.test.ts` 检查 DESIGN.md “Copy” 里能机器检查的规则。

浏览器引擎的 `readySelector`、`blockedSelector`、`isBlockedUrl`、`loginSelector`、`refusedPattern` 各自的含义见 [ARCHITECTURE.md](ARCHITECTURE.md) 第 5 节。没有已知验证码标记的引擎，`blockedSelector` 用 `':not(*)'`。

**取页面文字时用 `cleanText`**（`engines/shared.ts`），不要直接用 `textContent`：后者会把页面里内联的 `<script>`、`<style>` 的代码也读出来，曾经让 Google 的摘要里出现一大段 JavaScript。`cleanText` 跳过 `script`、`style`、`noscript`、`template`。

## 改配置

- **新增字段**：在 `packages/core/src/config.ts` 的 `DEFAULT_CONFIG` 里给默认值就够了，`mergeConfig` 会补上；如果它是 `judge` 里的嵌套对象（像 `judge.blocklists`），要在 `mergeConfig` 里给它单独加一层合并：`judge` 本身只浅合并，用户已存的那个对象会整个盖住默认值，缺的子字段就拿不到默认。
- **要改写用户已存的值**（把旧默认换成新默认、重命名一个取值）：把 `CONFIG_VERSION` 加一，在 `MIGRATIONS` 里写“从版本 n 升到 n+1”的函数。
- “恢复默认”（`apps/extension/lib/configReset.ts` 的 `resetKeepingSecrets`）会把所有字段改回默认值，只保留列出的 Key 和地址。新字段里如果有同样“重填很麻烦”的东西（密钥、服务地址），要加到那里。同一个文件的 `tidyConfig` 负责清掉旧版设置页存下的空行和重复项。

## 提交约定

提交信息用 Conventional Commits 的风格：`feat:`、`fix:`、`docs:`、`chore:`，需要时带范围（`feat(core):`、`fix(extension):`）。一次提交做一件事。写文档和提交信息时，**把没验证的和验证过的分开写**，不要把“测试通过”说成“真实环境验证过”。

## 已知的坑

| 现象 | 原因与做法 |
|---|---|
| 重新构建后浏览器里还是旧行为 | 见上面“同一路径的未打包扩展”：换新路径，并核对运行的脚本 |
| macOS 的 Chromium 里工作窗口没最小化 | `windows.create({ state: 'minimized' })` 被忽略，要创建后再 `windows.update` |
| 工作标签页跑进了用户的窗口，工作窗口被关掉 | `tabs.group` 不传 `createProperties.windowId` 时，新组建在**当前**窗口里 |
| 每次启动 Service Worker 闹钟都重新计时 | 同名的 `alarms.create` 会让闹钟重新开始，而 Worker 重启得比闹钟周期勤，所以先用 `alarms.get` 看有没有 |
| Chrome 的 `_favicon` 给大多数站点同一个占位地球 | 它只返回浏览器已有的图标；所以图标服务先比对占位图，再自己取站点图标 |
| X 一次只出 4–6 条 | 最小化的窗口里页面不可见，X 的虚拟列表不再渲染新推文；要更多就得把窗口调出来，这和“不打扰用户”冲突 |
| 知乎、小红书页面没有结果 | 没登录，或被风控（知乎会返回 `code 40362` 的 JSON）；用 `kiwi:refused` 的快速失败路径 |
| 用 `curl` 能通，浏览器里同一个地址却被拒 | 浏览器的连接可能走了代理的另一个出口（曾见某个决策模型服务对浏览器返回 HTTP 451）；先查代理分流规则，别急着怪代码 |
| DBLP 返回的不是 JSON | dblp.org 在 Anubis 工作量证明的机器人验证后面；来源会报“需要机器人验证”而不是返回空 |
| 测试里 `new Response('', { status: 304 })` 抛错 | 304 不能带 body，用 `null` |
| 页面打不开或被重定向到引擎不读的页面时，要等多久才失败 | 页面加载完 4 秒内内容脚本没有打招呼就快速失败（`tabRenderer.ts` 的 `HANDSHAKE_GRACE_MS`），来源状态记“上次出错”和原因，不用等满超时 |
