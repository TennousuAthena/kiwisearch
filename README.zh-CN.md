<p align="center">
  <img src="design/brand/kiwi-green/mark.svg" width="96" height="96" alt="Kiwi Search 标志">
</p>

<h1 align="center">Kiwi Search</h1>

<p align="center">
  在你自己的浏览器里同时搜索多个来源，得到合并、过滤后的一份结果，以及带引用的 AI 概览。
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b> · <a href="docs/USAGE.md#安装">开始使用</a> · <a href="LICENSE">MIT 许可证</a>
</p>

Kiwi Search 是面向 Chrome 和 Edge 的新标签页搜索扩展。

**你的浏览器，你的数据。** 所有结果都来自你自己的浏览器、你自己的登录状态和你自己填的 Key。Kiwi 不提供账号、代理或服务器，搜索结果只给你本人看。

## 功能

- **十种搜索模式**：网页、图片、视频、新闻、购物、学术、知乎、小红书、公众号、X。
- **34 个来源并排检索**：Google、Bing、DuckDuckGo、Brave、Google Scholar、YouTube、哔哩哔哩、OpenAlex、arXiv、PubMed、Exa 等，每个都能单独开关。
- **合并，而不是堆叠**：重复的链接和转载折叠成一条，多个来源都收录的结果排在前面。
- **少看垃圾**：决策模型隐藏内容农场和跑题的页面；也可以订阅 uBlock Origin、uBlacklist、hosts 格式的屏蔽列表，不需要任何 Key。
- **带引用的 AI 概览**：用你自己的 OpenAI 兼容模型或 Chrome 内置模型，概览流式生成，带 `[n]` 引用，语言可选；简短的事实问题会在结果上方直接给出快答。
- **为查资料而做**：智能学术搜索会把模型给出的论文逐篇到 OpenAlex 或 Crossref 核对；新闻可以限定最近一天、一周或一个月；购物展示淘宝、京东、亚马逊的商品卡片。
- **接入你的 Agent**：本地 MCP 服务让 Claude Desktop、Cursor 等 Agent 通过你的浏览器执行同一套搜索。

## 说明

Kiwi Search 只在你自己的浏览器中执行，由你本人或你自己的 Agent 主动发起；不会替你破解验证码，各来源分别排队并限速。搜索引擎的服务条款通常禁止自动化查询，这些措施不代表搜索引擎授权。请仅供个人使用，自行承担风险，并遵守当地法律及各来源的服务条款。第三方的标志和产品名称归其所有者所有。

## 许可证

[MIT](LICENSE)
