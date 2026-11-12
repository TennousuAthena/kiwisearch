# 屏蔽列表

屏蔽列表把你不想看到的网站从搜索结果里折叠掉：订阅别人维护的内容农场名单，或者自己写规则。它不需要任何 Key，也不需要决策模型。

被命中的结果不会消失：它们折叠在结果页底部（“已隐藏 N 条结果 · 显示”），每条写明原因，例如 `命中屏蔽列表“Content Farm Terminator”`，一次点击就能展开。第三方名单难免误伤，这样一眼就能发现。

## 怎么用

在扩展设置页的“屏蔽与偏好”里，“屏蔽列表”有三种用法：

1. **打开推荐名单**：Content Farm Terminator、AI uBlock Blacklist、BadWebsiteBlocklist，每个一个开关。打开后后台立即下载，名单下面显示规则条数和更新时间。
2. **按地址订阅别的名单**：填列表地址（必须是 `https://`，本机上的服务可以用 `http://localhost`），名称可选，会显示在已隐藏的结果上。
3. **自定义规则**：一个文本框，一行一条，可以直接粘贴 uBlock Origin、uBlacklist 或 hosts 格式的名单。框下面实时告诉你多少条有效、多少行没用上（并举几个例子）。规则只保存在这个浏览器里。

默认全部关闭、没有规则。订阅是向第三方主机发请求，所以要你自己打开。

## 谁说了算

一条结果同时命中几种规则时，按这个顺序决定：

1. **“不想看到的网站”**（设置页里的域名标签）：最高优先，折叠，标签是“来自你屏蔽的网站”。
2. **“优先显示的网站”**：只对屏蔽列表有效，列表不会折叠这个网站（它们的排名也会提高）。
3. **例外规则**（`@@||example.com^` 或 `@*://example.com/*`）：写在任何一个列表或自定义规则里，都能放行被任何列表命中的地址。
4. **列表规则**：折叠，标签是 `命中屏蔽列表“名称”`。多个列表同时命中时标第一个：先推荐名单（按目录顺序），再你订阅的（按订阅顺序），最后是自定义规则。

被列表折叠的结果之后不会因为决策模型喜欢它而放回来，主列表“至少保留 3 条”的兜底也只会恢复被决策模型判为垃圾或不相关的结果，不会恢复被屏蔽的。规则对“全部”模式里陆续到达的部分结果、晚到的来源、MCP 的搜索都生效；MCP 的 `structuredContent.hidden` 里每条带 `reason: "blocked"`，命中列表时还有 `list` 字段。

## 支持的写法

一行一条规则，每行按下面的写法识别。`www.` 和裸域名不区分。下表的写法都在真实解析器上跑过。

| 写法 | 例子 | 效果 |
|---|---|---|
| 域名 | `example.com`、`*.example.com`、`.example.com` | 这个网站和它所有的子域名；`notexample.com` 不受影响 |
| 域名加路径 | `example.com/blog` | 只屏蔽网站里这个栏目（路径前缀），`/about` 不受影响 |
| 通配域名 | `foo.blogspot.*` | `*` 代表任意内容，如 `foo.blogspot.com.au`；去掉 `*` 和 `.` 后至少要剩 5 个字符（`abc.de.*` 采用，`ab.cd.*` 不采用），否则太宽 |
| IPv4 地址 | `114.55.26.126` | 这个地址 |
| hosts 文件 | `0.0.0.0 example.com`、`127.0.0.1 example.com` | 同域名 |
| uBlock Origin / Adblock Plus 网络规则 | `\|\|example.com^`、`\|\|example.com^$doc` | 网站和子域名 |
| | `\|\|example.com/blog^` | 栏目。`^` 是分隔符：`/blog/post`、`/blog?x=1` 命中，`/blogger` 不命中；不写 `^` 的 `\|\|example.com/blog/` 是纯前缀 |
| | `\|https://example.com/page` | 以这个开头的地址，`http://` 的不算 |
| uBlacklist 匹配模式 | `*://*.example.com/*` | 网站和所有子域名 |
| | `*://news.example.com/*` | 只有这一个域名（`www.news.example.com` 算同一个，`a.news.example.com` 不算） |
| | `*://example.com/blog/*` | 栏目 |
| 正则 | `/blog\.example\.com\/(alice\|bob)/` | 在完整网址上不区分大小写地匹配；限制见下 |
| 例外 | `@@\|\|ok.example.com^`、`@*://docs.example.com/*` | 放行（见上一节），其余写法前面加 `@@` 或 `@` 都可以 |

uBlock / Adblock 规则里允许带的选项是 `$doc`、`$document`、`$all`、`$important` 和 `$reason="…"`（AI uBlock Blacklist 每行都带这个说明）。其他选项（`$script`、`$third-party` 等）说的是资源请求，不是“这个页面”，所以整条规则跳过。

### 会被跳过的

跳过不会让整个列表失败，只是不计入规则：

- 注释（`#`、`!` 开头）、`[Adblock Plus 2.0]` 这类头、uBlacklist 订阅开头用 `---` 围起来的名称说明块。
- 页面元素规则（`example.com##.ad`、`#@#`……）：它们隐藏的是网页里的元素，不是搜索结果。单独计数，设置页会写“N 行是页面元素规则，不适用于搜索结果”。
- 带资源选项的规则（见上）、写法看不懂的行、超过 1000 个字符的行。
- 不安全或太宽的正则。一条正则要被采用，必须同时满足：写出了网站名（`example\.com`）；不超过 400 个字符；没有 `(a+)+` 这样的嵌套量词（会拖死匹配）和反向引用；不会同时匹配三个互不相干的探测网址里的两个。所以 `/.*\/(.*)(s|q)=.*/` 这种只描述网址形状的正则会被丢掉，否则会误伤普通页面。这是启发式判断，不是证明。
- 只对列表自己写的 `/…/` 正则和 `|` 开头的规则做“要写出网站名”的检查；由已验证的域名生成的正则不受这条限制。

## 推荐名单

下表的数字是 2026-11-12 从真实地址下载后用本项目的解析器测的。名单不随扩展分发，由你的浏览器直接从来源下载。

| 名单 | 内容 | 规则数 | 许可 | 来源 |
|---|---|---|---|---|
| Content Farm Terminator | 中文内容农场，以繁体中文站点为主；有按博客作者屏蔽的规则 | 20,547（含 3,346 条正则和通配域名；4 行用不了） | MIT（文件头） | [danny0838/content-farm-terminator](https://github.com/danny0838/content-farm-terminator) |
| AI uBlock Blacklist | AI 批量生成的垃圾内容站，以英文站点为主 | 2,636（全部可用） | GPL-3.0 | [alvi-se/ai-ublock-blacklist](https://github.com/alvi-se/ai-ublock-blacklist) |
| BadWebsiteBlocklist | 拼凑文章、AI 垃圾站和误导性网站，以英文站点为主；有些规则只屏蔽站内某个栏目（如 `/blog/`） | 418（全部可用，其中 204 条是栏目规则） | CC0 | [popcar2/BadWebsiteBlocklist](https://github.com/popcar2/BadWebsiteBlocklist) |

这三个名单对 62 个常见站点（Wikipedia、GitHub、Stack Overflow、知乎、CSDN、掘金、BBC、arXiv 等）的首页，误伤的数量是 0。这只是抽样，不保证没有误伤。

### 没放进推荐的

- **eallion 的 uBlacklist 订阅合集**（[eallion/uBlacklist-subscription-compilation](https://github.com/eallion/uBlacklist-subscription-compilation)）：规模最大（15,630 条可用），但混着作者自己的口味：整个 `baidu.com`、`csdn.net`、`juejin.cn`、`amazon.com`、`sohu.com` 都在里面。订阅它，百度百科和 CSDN 的结果会全被折叠。想用的人可以自己按地址订阅（`https://raw.githubusercontent.com/eallion/uBlacklist-subscription-compilation/main/uBlacklist.txt`），用 `@@` 例外放行不想屏蔽的。它的 1,668 行页面元素规则和 144 行用不了的规则会被跳过。
- 其他名单（laylavish 的 HUGE-AI-Blocklist 列的是 AI 工具站不是垃圾站，误伤高；cobaltdisco、wdmpa、Paxxs 的已基本停更）没有放进去。

## 更新方式

订阅名单由后台负责下载、解析并保存：

- **什么时候更新**：成功后 24 小时内不再请求；失败后 1 小时可以重试。Service Worker 每次启动时检查一次（浏览器启动也算），另有每 6 小时一次的闹钟。你打开一个名单、新增订阅、改了订阅地址、关掉或删除订阅时也会立即处理。设置页的“立即更新”会强制重新下载。
- **怎么下载**：不带 Cookie，不带 Referer，用上次的 `ETag` 询问，对方答“没变”（HTTP 304）就保留现有规则，只记下这次检查的时间。最大 12 MB，30 秒超时。对方只能知道“某个浏览器在请求这个文件”，不知道你搜了什么。
- **失败时**：HTTP 错误、连不上、超时、或者返回的页面里一条规则也读不出来（比如地址指向了一个网页），都算失败。失败只会让状态行变红并说明原因，之前下载的规则继续生效（“这次更新失败：…。仍在用之前的版本”）。浏览器存储空间不够时也会明说。
- **关掉或删除**：关掉一个订阅，它就不再折叠任何结果；删除它（包括先关掉再删除）会把已存的规则一并清掉。地址换了，旧规则作废，重新下载。

搜索匹配全在本地进行：搜索词和结果不会发给名单的主机。

## 存储与性能

- `chrome.storage.local` 里，`blocklistMeta` 存每个名单的小状态（地址、下载和检查时间、`ETag`、规则数、错误），设置页读它；`blocklist:<id>` 存解析好的规则（Content Farm Terminator 约 630 KB），只有搜索才读，并且在 Service Worker 里按名单留一份内存副本，避免每次搜索都解析几兆 JSON。
- 匹配时，域名规则放在 `Set` 里，沿着主机名的层级逐级查（`a.b.example.com` → `b.example.com` → `example.com` → `com`）；正则规则逐条测，只看网址的前 2048 个字符；每次搜索对同一个地址只算一次。在 Content Farm Terminator、eallion 合集、AI uBlock Blacklist 和 BadWebsiteBlocklist 四个真实名单同时打开的情况下，100 条不命中的结果大约要 39 毫秒。
- 自定义规则的文本框上限 50 万个字符；很大的名单请用订阅，不要粘贴。

## 已知限制

- **匹配用的是结果自己的网址和域名。** 搜狗微信这类返回中转链接的结果，路径规则和正则看不到真实地址，只有按网站的规则（匹配结果的域名 `mp.weixin.qq.com`）能命中。
- **正则的安全检查是启发式的。** 它拦下了已知的危险和过宽的写法，但不能证明任意正则都安全。
- **推荐名单的地址不归我们管。** 2026-11-12 抓取验证过；对方搬家或删除后，设置页会显示下载失败。
- **从目录里删掉一个推荐名单后**，用户配置里留下的 id 会被忽略（不再下载），但它已存的规则不会被清理，因为清理只认“不在配置里”的名单。
- **只在 Chromium 里跑过**，Firefox 没试。每 6 小时的闹钟没有在真实浏览器里等过，“什么时候该更新”的判断有单元测试。

## 验证记录（2026-11-12）

- **对着真实名单写成**：解析器是对着上面四个真实名单的每一种行写出来的（Content Farm Terminator 的 3,224 条正则，其中许多内部有未转义的斜杠和行尾注释；`foo.blogspot.*` 这样的通配域名；AI uBlock Blacklist 每行的 `reason="…"`；popcar2 只屏蔽栏目的规则；eallion 里上千行页面元素规则、IP 规则、一个全角冒号的笔误）。测试夹具 `packages/core/test/fixtures/blocklist-excerpts.txt` 是从它们里原样摘的 29 行规则（另有 5 行说明来源的注释）。
- **单元测试**：`packages/core/test/blocklist.test.ts` 23 条（解析、匹配、例外、正则安全、订阅目录），扩展里 `test/blocklistState.test.ts` 13 条（下载、304、大小限制、该不该更新、变化判断、状态文字），另在 judge、pipeline、config、MCP 和恢复默认的测试里各有补充。
- **真实 Chromium 里端到端**（无头、全新配置文件；只开一个真实的 Exa 搜索来源，一次搜索返回 10 条；本机起一个可控的名单服务）共 24 项检查，全部通过：后台自己下载订阅名单；Exa 结果里命中的两条折叠并标上名单名；`@@` 例外能放回来；只用自定义规则（不订阅）也能折叠，标签是“自定义规则”；强制刷新发出上次的 `ETag` 并收到 304，规则和下载时间不变；HTTP 500 和“返回网页”都报错、旧规则继续折叠结果；名单内容变了规则整体替换；关掉的名单不折叠；删除（含先关再删）会清掉已存规则；三个推荐名单从真实地址经扩展下载（20,547 / 2,636 / 418 条），普通搜索里没有误伤。
- **没验证到的**：6 小时闹钟自己触发、Firefox。真实搜索只试过两个搜索词（一个用浏览器引擎，一个用 Exa），没有系统地看过各种查询下推荐名单的误伤和漏网情况。

## 给维护者

**加一个推荐名单**：在 `packages/core/src/blocklist.ts` 的 `RECOMMENDED_BLOCKLISTS` 里加一项（`id` 一旦发布就不要改，它存在用户的配置里）。加之前：

1. 下载它，用 `parseBlocklist` 解析，看 `stats.rules` 和 `stats.unsupported`；`unsupported` 很多时先看是哪类行（解析器可能要补一种写法）。
2. 用一批常见站点的首页检查有没有误伤；名单是不是只管“低质量站点”，还是混了作者的个人口味。
3. 查清并写下它的许可，只写它自己声明的。
4. 地址必须是 `https://`；`blocklist.test.ts` 里有一条检查目录里的 id 不重复、地址是 https、字段不为空。

**代码地图**：

| 文件 | 职责 |
|---|---|
| `packages/core/src/blocklist.ts` | 解析（`parseBlocklist`）、匹配（`compileBlocklist`）、推荐目录、订阅地址检查、把用户规则和订阅名单合在一起（`loadBlocklist`） |
| `packages/core/src/judge.ts` | `applyDomainRules(results, judge, lists)`：优先级的实现 |
| `packages/core/src/pipeline.ts` | 搜索开始时读名单；部分结果、最终结果、晚到结果都过一遍 |
| `packages/core/src/types.ts` | `BlocklistSettings`、`BlockRules`、`HiddenReason`（带 `list`）、`Env.loadBlocklists` |
| `apps/extension/lib/blocklistService.ts` | 存储和下载：`loadBlocklistRules`（搜索用）、`refreshBlocklists`、清理、`kiwi:blocklist-refresh` |
| `apps/extension/lib/blocklistState.ts` | 纯逻辑：该不该更新、怎么读下载、变化判断、状态文字 |
| `apps/extension/entrypoints/options/BlocklistsPanel.tsx` | 设置页面板 |
| `apps/extension/entrypoints/background.ts` | 注入 `loadBlocklists`，安排刷新（启动时、闹钟、配置变化时） |
