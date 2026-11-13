# 使用指南

怎么安装、每个功能怎么用、有哪些搜索模式和来源、设置页各分区、AI 功能、屏蔽列表和 MCP 服务。项目简介看 [README](../README.zh-CN.md)，其他文档的索引看 [docs/README.md](README.md)。

## 安装

需要 Node.js 24 和 pnpm 12：

```sh
pnpm install
pnpm --filter @kiwi-search/extension build
```

在 Chrome 打开 `chrome://extensions`（Edge 打开 `edge://extensions`），启用“开发者模式”，选择“加载已解压的扩展程序”，并选择：

```text
apps/extension/.output/chrome-mv3
```

扩展的设置页以整页标签打开（不是 `chrome://extensions` 里那个小嵌入窗口）；首次安装会自动打开一次，里面有“开始使用”引导。要用 MCP 服务，还需要构建 MCP 包，见下文“MCP 服务”。

## 功能详情

- **搜索模式**：网页、图片、视频、新闻、购物、学术，以及知乎、小红书、公众号、X 等平台。每个来源声明自己支持哪些模式，搜索时只查支持当前模式的来源。模式会陆续增加，当前的完整列表见下文“搜索模式与来源”。
- **多个来源**：一部分由浏览器渲染（Google、Bing、DuckDuckGo、Brave 网页、Google Scholar、YouTube、哔哩哔哩、知乎、小红书、X 等），一部分走官方 API（OpenAlex、Crossref、arXiv、PubMed、Exa、Brave API 等）。来源会陆续增加，当前的完整列表见下文“搜索模式与来源”和扩展的设置页。
- **去重与融合**：URL 归一化（去跟踪参数，DOI、arXiv、视频、笔记各有自己的键），论文按 DOI 或标题加年份合并，同一篇文章的多站点转载折叠成一条，维基百科同一词条的各语言版本和简繁体（粤语、吴语、文言等）按浏览器语言只留一份，最后 RRF 融合，每个来源的权重可调。
- **决策模型过滤**：判断每条结果是否相关、是否内容农场或搬运内容，以及你写的自然语言规则；被隐藏的结果折叠在页面底部，注明原因，一次点击展开。决策模型是可换服务商的一层，见 [docs/DECISION-PROVIDERS.md](DECISION-PROVIDERS.md)。
- **屏蔽列表**：订阅别人维护的内容农场名单，或粘贴自己的规则，支持 uBlock Origin、uBlacklist 和 hosts 格式，不需要任何 Key。见 [docs/BLOCKLISTS.md](BLOCKLISTS.md)。
- **AI 概览**：用你自己的 OpenAI 兼容模型（或 Chrome 内置模型）流式生成带 `[n]` 引用的概览；多个平台的帖子混在一起时，会分别说明各平台怎么说、有什么不同。概览的语言可以设置：默认跟随浏览器的首选语言，也可以选“自动”（跟着你搜索词的语言）、从 20 种语言里指定一种，或自己写一种。
- **按意图补搜**：“全部”模式里，决策模型读搜索词，判断要不要同时搜学术、知乎、小红书、公众号，或建议你切到图片、视频、学术标签。
- **新闻搜索**：输入关键词后切到“新闻”，支持不限时间 / 24 小时 / 一周 / 一个月、按相关性或发布时间排序；显示媒体、时间和来源，手动刷新重新检索。没有关键词时不加载热点。新闻只合并同一 URL，保留不同媒体的独立报道。
- **购物搜索**：淘宝、京东、亚马逊美国站的商品卡片，展示页面上的图片、价格和店铺信息。三个来源默认开，只在购物标签下查询；需要登录时沿用你当前浏览器的账号。不同商家的商品保留为独立结果，不做 AI 概览，价格以商品页为准。
- **智能学术搜索**：你自己的模型把查询改写成检索式和代表论文，逐篇到 OpenAlex（或 Crossref）核对，查不到的丢掉，页面上有“核心文献”块。
- **学术语言**：学术标签里可以选“仅英文”，选择会记住。OpenAlex、PubMed、Europe PMC、Google Scholar 按语言检索；其余来源和所有结果再按标题检查，不是英文的折叠到“已隐藏”，注明语言不符。用中文搜索时，智能学术搜索会把检索式改写成英文。
- **MCP 服务**：Claude Desktop、Cursor 等 Agent 通过本地 MCP 服务调用同一套搜索，共用队列、限速和缓存。

## 默认搜索引擎

Chrome 不允许扩展自动更改默认搜索引擎，因此需要手动添加一次 Kiwi Search。打开 `chrome://settings/searchEngines`，然后：

1. 在“网站搜索”旁点击“添加”。
2. 填入名称 `Kiwi Search`、快捷字词 `kiwi`、网址 `https://s.kiwi.moe/s?q=%s`。
3. 在该条目的 ⋮ 菜单中选择“设为默认”。

也可以在扩展设置页使用复制按钮复制这些字段。不改默认也可以在地址栏输入 `k` 加空格快速使用 Kiwi。`https://s.kiwi.moe/s?…` 这个地址由扩展在浏览器里直接重定向到它自己的结果页。

## 搜索模式与来源

| 模式 | 来源 | 备注 |
|---|---|---|
| 网页 | Google、Bing、DuckDuckGo、Brave 网页方式（浏览器渲染，不要 Key）；Brave API、Exa、DeepSeek Search、SearXNG（API，前三个要 Key，SearXNG 要自己的服务地址）；Yandex、百度、搜狗网页、元宝搜索（so.qq.com）、Kagi（浏览器渲染，默认关） | Brave 有两种方式搜同一个索引：网页方式不要 Key，API 方式要；有 Key 时关掉一个，否则 Brave 在融合里算两次。百度默认关（结果页混有翻译、推荐等不是搜索结果的卡片），勾选时会先弹窗确认。Kagi 是付费搜索，登录你的 Kagi 账号后每次搜索都会计入账号的搜索用量，所以默认关，勾选时同样先弹窗确认 |
| 图片 | Bing 图片（浏览器渲染）、Openverse（API，自带授权信息） | 不生成概览、不做过滤 |
| 视频 | YouTube、哔哩哔哩、抖音（浏览器渲染；抖音默认关，需登录） | 不生成概览、不做过滤 |
| 新闻 | Google、Brave 网页方式（浏览器渲染）；Brave API、Exa（沿用已有 Key 与开关） | 按关键词检索；限定时间时隐藏发表时间未知的报道。Brave 的日期可能是更新日期，保留原始标签，不作为发表时间筛选依据 |
| 购物 | 淘宝、京东、亚马逊美国站（浏览器渲染，默认开） | 淘宝和京东可能需要登录；显示页面原有币种和价格，不做跨平台最低价判断；不生成概览 |
| 学术 | Google Scholar（浏览器渲染）；OpenAlex、Crossref、arXiv、PubMed（API，无需 Key）；Europe PMC、DBLP（API）；百度学术、知网、Web of Science（浏览器渲染） | Google Scholar、OpenAlex、Crossref、arXiv、PubMed 默认开；Europe PMC、DBLP、百度学术、知网、Web of Science 默认关，按需打开 |
| 知乎 | 知乎（浏览器渲染，需登录） | 过滤和概览只用结果卡片里的摘录 |
| 小红书 | RedNote（国际站，默认开）、小红书国内站（默认关）；浏览器渲染，需登录 | 笔记卡片墙，不做概览和过滤 |
| 公众号 | 搜狗微信（浏览器渲染，不需登录） | 找微信公众号文章 |
| X | X（浏览器渲染，需登录） | 推文列表，不做概览和过滤 |

### 浏览器渲染的来源

Google、Bing、DuckDuckGo、Brave（网页）、Kagi、Google Scholar、元宝搜索、YouTube、哔哩哔哩、抖音、知乎、小红书（国内站和 RedNote）、搜狗（含微信公众号搜索）、X 等来源通过一个单独的、已最小化的窗口在浏览器中渲染，不占用你正在用的窗口。

- **登录**：抖音、知乎和小红书用的是你自己浏览器里的登录状态，需要先登录；小红书的国内站和国际站账号各自独立，在设置里勾选你登录的那个。
- **Kagi**：用浏览器里已有的 Kagi 登录。没登录时第一次搜索要先通过 Kagi 自己的人机验证（Cloudflare Turnstile），页面上会提示“去验证”，通过后同一浏览器里的后续搜索直接出结果；没登录的访客有 50 次免费搜索（页面上的计数，没测到用完）。已登录时直接打开结果页没有遇到验证（只试过一次）。试用账号有 150 次搜索，每次 Kiwi 搜索都会花掉一次。未登录和已登录（试用账号）两种结果页的结构都对着真实页面核对过，付费套餐的页面没有核对（见 [STATUS.md](STATUS.md)）。
- **验证码**：不会自动破解，也不会自动弹窗。搜索页上会有一行提示和“去验证”，你需要时再点。Brave 网页偶尔会让一个全新的浏览器拖滑块验证。
- **X**：同样用你浏览器里的登录状态，只有你点开“X”标签时才会访问它，两次请求至少间隔 10 秒，不做结果过滤和概览。X 对自动化使用管得很严，仍有让账号被限制的风险，建议用小号。因为工作窗口是最小化的，X 只会渲染首屏的几条推文，一次搜索通常得到 4–6 条。
- **学术里的三个**（百度学术、知网、Web of Science）只返回你自己的浏览器能看到的内容：Web of Science 需要机构 IP 或你自己的登录，没有权限时会提示被拦截；知网和百度学术可能要你手动过一次验证码。

### API 来源

OpenAlex、Crossref、arXiv、PubMed、Europe PMC、DBLP、Openverse、Exa、DeepSeek Search、Brave Search API 和 SearXNG 通过各自的官方 API 或你自己的服务调用。需要 Key 的来源可先启用，填入 Key 后才会参与搜索。

- PubMed 默认开，不填 Key 也能用；填你自己的 NCBI Key 可把限额从每秒 3 次提到 10 次。
- OpenAlex 不填 Key 也可使用，但同一 IP 下免费额度约为每天 `$0.10`；免费注册 Key 可将额度提高到约 `$1/天`：[OpenAlex API 设置](https://openalex.org/settings/api)。
- Openverse 匿名访问有限额（每页最多 20 条，每天 200 次），靠来源缓存摊薄。

## 设置

设置页按用途分成几个区，改动自动保存：

| 分区 | 内容 |
|---|---|
| 开始使用 | 第一次打开时的引导：默认搜索引擎的字段、要登录的平台；完成后不再显示 |
| 搜索范围 | 每个来源的开关、Key 和地址，以及上一次真实搜索里它的状态（正常、没结果、要登录、要验证、出错）；按类型分组，带一键预设 |
| AI 功能 | AI 模型（概览用）、AI 概览（含概览语言）、智能学术搜索、决策模型（含“测试连接”）、没有决策模型时可用的重排 |
| 屏蔽与偏好 | 不想看到的网站、优先显示的网站、屏蔽列表和自定义规则 |
| 高级 | 每个来源取多少条、渲染节奏、来源权重、维基百科语言版本、各项阈值、MCP 桥、恢复默认（保留 Key 和地址） |

## AI 功能

**AI 概览**：默认使用 OpenAI 兼容 API，DeepSeek 预设使用 `https://api.deepseek.com/v1` 和 `deepseek-flash`。也可在设置里选择 OpenAI、OpenRouter、Ollama 或 Chrome 内置模型。内置模型只在支持 Prompt API 的浏览器新标签页上下文中生成；MCP `answer` 工具需要 API 摘要提供方。

**概览语言**（设置 → AI 功能 → AI 概览 → “概览语言”）：
- **跟随浏览器**（默认）：用浏览器语言设置里排第一的语言写，不管你搜什么。注意这是浏览器的首选语言，不是你搜索词的语言：浏览器是英语、搜中文，概览也是英语。
- **自动**：跟着每次搜索词的语言走，搜中文写中文，搜英文写英文。
- **指定语言**：简体中文、繁體中文、English、日本語、한국어、Español、Français、Deutsch 等 20 种。
- **其他语言**：自己写语言的名字（Italiano、Svenska、文言文……）或语言代码（`pt-BR`），最多 40 个字。
- 引用编号 `[n]`、专有名词和代码保持原样。MCP 的 `answer` 用同一个设置。Chrome 内置模型目前只支持英语、日语、西班牙语、德语和法语的输出，选别的语言时设置页会提醒。

Ollama 默认不允许浏览器扩展跨源访问。使用时请启动 Ollama 并设置：

```sh
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

**决策模型**：回答搜索里的小问题（这条结果相关吗？是内容农场吗？这个查询是不是学术问题？）。推荐用专门做这件事的小模型，快、便宜；默认预设是 TypeSafe 的 Jev，也可以填任何实现协议的服务地址（本机服务可不要 Key）。没配专用模型、或它明确拒绝时，可以改用你的 AI 模型兜底，慢几秒。决策模型可用时，搜索“全部”会判断要不要同时搜学术、知乎、小红书、公众号；没有可用的决策模型时只搜通用来源，也不做过滤。协议和各种情形见 [docs/DECISION-PROVIDERS.md](DECISION-PROVIDERS.md)。

隐私：决策模型可用时，搜索词和每条结果的标题、网址、摘要会发给它：专用服务，或兜底时你的 AI 模型。两者都没配好就不发送，只用域名规则和屏蔽列表。

## 屏蔽与偏好

不需要任何 Key，也不需要决策模型：

- **不想看到的网站**和**优先显示的网站**：输入域名，也可以直接粘贴一串。屏蔽的结果折叠到页面底部，优先的网站排名提高，也不会被屏蔽列表折叠。
- **屏蔽列表**：打开推荐的名单（Content Farm Terminator、AI uBlock Blacklist、BadWebsiteBlocklist），或按地址订阅别的，或直接把规则粘贴到自定义规则里。命中的结果折叠，并注明是哪个列表。名单由你的浏览器直接从来源下载，每天最多更新一次，默认全部关闭。

写法、优先级、推荐名单的来历和已知限制见 [docs/BLOCKLISTS.md](BLOCKLISTS.md)。

## MCP 服务

先构建 MCP 包：

```sh
pnpm --filter @kiwi-search/mcp build
```

将 MCP 服务配置到 Claude Desktop：

```json
{
  "mcpServers": {
    "kiwi-search": {
      "command": "node",
      "args": ["/绝对路径/kiwi-search/packages/mcp/dist/index.js"]
    }
  }
}
```

Cursor 的 MCP 配置使用相同的 `command` / `args`，写入项目或用户的 `mcp.json`。

MCP 服务首次运行时，会在 `~/.kiwi-search/token` 以 `0600` 权限生成配对令牌，并将令牌和设置说明输出到 stderr。将令牌复制到扩展“设置 → 高级 → MCP 桥 → 配对令牌”，保存并保持浏览器运行。服务只监听 `127.0.0.1`；如需额外限制扩展 ID，可设置 `KIWI_EXTENSION_ID`。默认端口为 `17345`，可通过 `KIWI_PORT` 修改；同一端口上后续启动的 MCP 客户端会通过现有本地服务中继到扩展。

提供的工具：

- `search(query, mode?, language?, news?, refresh?, sources?, limit?)`：返回融合结果、摘要片段以及各来源排名。`mode` 取 `web`（默认）、`images`、`video`、`news`、`shopping`、`academic`、`zhihu`、`xiaohongshu`、`wechat`、`x`。`limit` 为 1–100，默认 10。被过滤的结果不在列表里，只在 `structuredContent.hidden` 中给出原因（命中屏蔽列表时还带列表名）。
  - `language` 只用于学术模式：`en` 只保留英文文献，默认 `any` 不限；不符的结果在 `structuredContent.hidden` 里，原因是 `language`。
  - `news` 只用于新闻模式：`{ range: any | day | week | month, sort: relevance | date }`；限定时间范围时，发表时间未知的报道会被隐藏。
  - `refresh: true` 让这一次请求跳过来源缓存；浏览器里的队列和限速仍然生效。
- `answer(query, mode?, language?, news?, refresh?, sources?)`：返回带 `[n]` 引用的摘要，参数含义同 `search`；`images`、`video`、`shopping`、`xiaohongshu` 和 `x` 模式没有可总结的文本，请用 `search`。
- `list_sources()`：查看插件报告的来源可用状态。

## 合规说明

Kiwi Search 只在用户自己的浏览器中执行，由用户本人或用户自己的 Agent 主动发起；不会自动破解验证码，遇到验证时只在搜索页上提示，由你需要时再点“去验证”，不会自动弹出窗口；各来源分别排队并限速。搜索引擎服务条款通常禁止自动化查询，这些措施不代表搜索引擎授权。请自行承担使用风险，仅供个人使用，并遵守当地法律及各来源的服务条款。
