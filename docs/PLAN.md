# Kiwi Search 计划书（草案 v0.3）

> 来源分两类：没有公开 API 的引擎（Google、Bing、百度等）在用户真实浏览器里渲染后读取页面；有官方 API 的（OpenAlex、Exa、DeepSeek Search 等）直接调用 API，用户在设置里配置。所有执行都在插件里，没有 Node 兜底；MCP 收到的请求全部交给插件执行。

## 1. 定位

做浏览器插件的原因是：服务端直接请求搜索引擎会进反爬页面，而用户自己的浏览器本来就能正常打开这些页面。插件做的事情，相当于替用户打开各家结果页，把页面上的结果读出来，再合并、重排、总结。

**合规边界：**
1. **只在用户自己的浏览器里执行。** 每次搜索都由用户（或用户自己的 Agent）主动发起，结果只给用户本人看，不转发，也不做成服务。
2. **遇到验证码不自动破解。** 把那个页面切到前台，让用户自己完成验证。
3. **频率接近真人。** 每个引擎单独限速、请求排队，单个引擎失败也不影响其他引擎。
4. **照常带用户自己的 Cookie 和登录状态**，不伪造请求头。

需要说明一点：各家搜索引擎的服务条款一般都禁止自动化查询。上面几条能把个人使用的风险压得很低，但并不等于对方授权。README 里会写明这一点。

## 2. 来源

**A 类：浏览器渲染（这些引擎不提供可用的公开 API）**

| 引擎 | 类型 | MVP |
|---|---|---|
| Google | 综合 | ✅ |
| Bing | 综合 | ✅ |
| 百度 | 中文 | ✅ |
| DuckDuckGo | 综合，偏隐私 | ✅ |
| Google Scholar | 学术 | ✅ |
| Yandex | 俄语、东欧 | 可选 |

每个引擎写成一个适配器，包含四部分：
- `buildUrl(query)`：拼出该引擎的搜索链接。
- `readySelector`：页面上出现哪个元素就说明结果已经渲染好。
- `blockedSelector`：识别验证码或拦截页。
- `extract(document)`：直接在页面的 DOM 里读出 `{url, title, snippet, rank, extra}`。

解析在 content script 里直接读 DOM。每个适配器都配一份真实页面的 HTML 快照做回归测试，页面改版时能马上发现。

**B 类：官方 API（用户在设置里填 Key 并开启）**

| 来源 | 接口 | 计费 / Key | 特点 |
|---|---|---|---|
| OpenAlex | `GET api.openalex.org/works` | 不需要 Key 也能用，但同一 IP 下所有人共享每天 $0.10 的额度（一次搜索 $0.001，约 100 次）；注册免费 Key 后独享每天 $1（约 1000 次），翻页超过第一页必须用 Key（[文档](https://help.openalex.org/api/authentication.md)） | 学术元数据：作者、期刊、被引数、DOI |
| Exa | `POST api.exa.ai/search` | 付费，有每月免费额度 | 语义检索，可同时返回正文 |
| DeepSeek Search | `POST api.deepseek.com/v1/tools/search` | 用 DeepSeek 的 Key | 中文强，自带 `rerank_score`、summary 和正文 |
| Brave Search | `GET api.search.brave.com/res/v1/web/search` | 每月 $5 免费额度 | 自有索引 |
| SearXNG（可选） | 自建实例的 `/search?format=json` | 不需要 Key | 自托管元搜索 |

两类来源对上层是同一个接口：`search(query, ctx) → SearchHit[]`。B 类由 background 直接 fetch。新增来源只需要写一个适配器。

## 3. 怎么在浏览器里打开结果页（已定：方案 A + 标签组）

**默认做法：** 在用户当前窗口里建一个折叠起来的标签组，名字叫“Kiwi Search”，颜色设为灰色。渲染要用的标签页都以 `active: false` 方式开在这个组里。
- 这些都是普通的顶层标签页，带用户自己的第一方 Cookie，请求特征跟用户亲手打开没有区别，最不容易触发反爬。
- 标签组折叠后只在标签栏占一个小标签，打扰很小。

**复用与回收：**
- 每个来源固定保留一个工作标签页，下次搜索直接在这个页面里换地址，不用反复新建、关闭。
- 闲置超过 N 分钟（可配置）就关闭整个组。

**遇到验证码：** 展开标签组并切到那个标签页，由用户自己完成验证；验证完成后会被自动识别，搜索继续。

**几种特殊情况：**
| 情况 | 处理 |
|---|---|
| 当前没有普通窗口，比如 MCP 请求进来时浏览器没有前台窗口 | 新建一个最小化窗口，在里面建同样的标签组 |
| 无痕窗口 | 不使用 |
| 用户手动展开或拖走了工作标签页 | 能识别出来，并重建标签组 |
| 浏览器限制后台标签页 | 后台页面的定时器和渲染可能被降频，需要在 M0 里实测；如果明显变慢，加一个 `readySelector` 加轮询的兜底，同时调整超时 |

**备选：** 方案 B（offscreen 文档里放不可见 iframe）保留成实验开关，默认关闭。

**额外需要的权限：** `tabs`、`tabGroups`。

**M0 验收：** 在真实 Chrome 里，A 类的 5 个引擎各跑 20 次查询，统计成功率、耗时和验证码出现率，同时确认标签组不会自动展开、不会抢走焦点。

## 4. 架构

```
apps/extension       WXT + React，Manifest V3（Chrome/Edge）
  newtab             搜索页：各引擎状态、融合结果、AI 摘要
  options            每个来源的开关、Key、权重、限速；LLM、reranker、MCP 桥设置
  background         调度器（队列、限速、超时）、融合与重排、摘要、MCP 桥客户端
  content/<engine>   各引擎的 DOM 提取适配器
packages/core        与浏览器无关的纯逻辑：B 类 API 适配器、URL 规范化、去重、RRF、重排、prompt、引用
packages/mcp         stdio MCP Server，只做转发：通过 127.0.0.1 上的 WebSocket 把请求交给插件
```

**处理流程：**
1. 并发查询：A 类打开结果页并在 DOM 里提取，受限速约束；B 类调用 API。
2. 每个来源单独设超时，失败了不影响其他来源。
3. URL 规范化后去重（去跟踪参数；arXiv、DOI 合并）。
4. RRF 融合，每个引擎的权重可以调。
5. 取前 30 条精排。
6. 读取前 8 篇正文：先用后台 fetch，读不到再用工作标签页渲染后提取正文。
7. LLM 流式生成摘要，带 [n] 引用。

**重排和摘要（这一步不属于搜索来源，属于模型）：**
- 摘要：调用 OpenAI 兼容接口，自带 Key（DeepSeek、OpenAI、OpenRouter，或本地 Ollama）。可选 Chrome 内置的 Gemini Nano（Prompt API），这样不用 Key。
- 重排：默认让 LLM 打分。可选在浏览器里跑本地 cross-encoder（用 transformers.js 加载 bge-reranker 或 jina-reranker 的 ONNX 模型，WebGPU/WASM 加速），免费，数据也不出本机。

**MCP：**
- 提供两个工具：`search(query, engines?, limit?)` 和 `answer(query, engines?)`，后续再加 `fetch_page(url)`。
- 插件没连上时，直接返回“请打开浏览器并启用插件”。Key 只在插件里配置一处，MCP 不单独保存 Key。
- WebSocket 只绑定 127.0.0.1，并校验 Origin 必须是 `chrome-extension://<id>`，再加一个配对令牌。
- Agent 发来的请求和用户自己的搜索走同一个队列和限速，避免 Agent 高频调用把账号或 IP 搞进风控。

## 5. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 技术验证 | 标签组渲染调度器；Google、Bing 两个适配器 | 达到第 3 节的验收标准 |
| M1 适配器与 core | A 类 5 个引擎的适配器加 HTML 快照测试；B 类接入 OpenAlex、Exa、DeepSeek、Brave Search；去重、RRF、LLM 重排 | A 类每个引擎在真实浏览器里能拿到 ≥8 条结果；B 类填好 Key 就能用 |
| M2 新标签页 | 流式 UI、各引擎状态、验证码引导、设置页 | 搜一个中文问题和一个英文学术问题，都能看到多引擎融合结果和带引用的摘要 |
| M3 MCP | stdio Server、WebSocket 桥、配对、共用限速 | 用 MCP Inspector 调 `search` 和 `answer` 能返回结果；插件关闭时有明确报错 |
| M4 打磨 | 本地 reranker、结果缓存、按查询意图选引擎（学术问题优先 Scholar）、nDCG 评测集 | 后续再定 |

## 6. 待确认

1. **来源清单：** A 类先做 Google、Bing、百度、DuckDuckGo、Google Scholar；B 类先做 OpenAlex、Exa、DeepSeek、Brave Search，SearXNG 作为可选。这样可以吗？
2. **摘要模型：** 用户自带 LLM Key（默认 DeepSeek），另外提供 Chrome 内置模型作为免 Key 选项，这样可以吗？
3. **结果页布局：** 结果在左、摘要在右侧栏，还是摘要在上、结果在下？
4. **默认开启：** 默认开启哪些来源？我建议 A 类全开；B 类里 OpenAlex 默认开（不带 Key 每天约 100 次，设置页提示去申请免费 Key），其他的填了 Key 才开。
