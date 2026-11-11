# Kiwi Search

Kiwi Search 是面向 Chrome / Edge 的 MV3 新标签页搜索扩展：在用户自己的浏览器中查询多个搜索来源，按 URL 去重并用 RRF 融合，可选重排，最后流式生成带 `[n]` 引用的 AI 摘要。它也包含一个本地 stdio MCP 服务，将 Agent 发来的工具调用转发给浏览器插件执行。

## 安装扩展

需要 Node.js 24 和 pnpm 12：

```sh
pnpm install
pnpm --filter @kiwi-search/extension build
pnpm --filter @kiwi-search/mcp build
```

在 Chrome 打开 `chrome://extensions`（Edge 打开 `edge://extensions`），启用“开发者模式”，选择“加载已解压的扩展程序”，并选择：

```text
apps/extension/.output/chrome-mv3
```

## 默认搜索引擎

Chrome 不允许扩展自动更改默认搜索引擎，因此需要手动添加一次 Kiwi Search。打开 `chrome://settings/searchEngines`，然后：

1. 在“网站搜索”旁点击“添加”。
2. 填入名称 `Kiwi Search`、快捷字词 `kiwi`、网址 `https://s.kiwi.moe/s?q=%s`。
3. 在该条目的 ⋮ 菜单中选择“设为默认”。

也可以在扩展设置页使用复制按钮复制这些字段。不改默认也可以在地址栏输入 `k` 加空格快速使用 Kiwi。

打开扩展的“设置”页配置来源和模型。Google、Bing、百度、DuckDuckGo、Google Scholar 等 A 类来源通过折叠的“Kiwi Search”标签组在浏览器中渲染；OpenAlex、Exa、DeepSeek Search、Brave Search 和 SearXNG 通过各自的官方 API 调用。需要 Key 的 API 来源可先启用，填入 Key 后才会参与搜索。

OpenAlex 不填 Key 也可使用，但同一 IP 下免费额度约为每天 `$0.10`；免费注册 Key 可将额度提高到约 `$1/天`：[OpenAlex API 设置](https://openalex.org/settings/api)。

摘要默认使用 OpenAI 兼容 API，DeepSeek 预设使用 `https://api.deepseek.com/v1` 和 `deepseek-flash`。也可在设置里选择 OpenAI、OpenRouter、Ollama 或 Chrome 内置模型。内置模型只在支持 Prompt API 的浏览器新标签页上下文中生成；MCP `answer` 工具需要 API 摘要提供方。

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

Cursor 的 MCP 配置也可使用相同的 `command` / `args`，写入项目或用户的 `mcp.json`：

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

MCP 服务首次运行时，会在 `~/.kiwi-search/token` 以 `0600` 权限生成配对令牌，并将令牌和设置说明输出到 stderr。将令牌复制到扩展“设置 → MCP 桥 → 配对令牌”，保存并保持 Chrome / Edge 运行。服务只监听 `127.0.0.1`；如需额外限制扩展 ID，可设置 `KIWI_EXTENSION_ID`。默认端口为 `17345`，可通过 `KIWI_PORT` 修改；同一端口上后续启动的 MCP 客户端会通过现有本地服务中继到扩展。

提供的工具：

- `search(query, sources?, limit?)`：返回融合结果、摘要片段以及各来源排名。
- `answer(query, sources?)`：返回带 `[n]` 引用的摘要。
- `list_sources()`：查看插件报告的来源可用状态。

Ollama 默认不允许浏览器扩展跨源访问。使用时请启动 Ollama 并设置：

```sh
OLLAMA_ORIGINS="chrome-extension://*" ollama serve
```

## 合规说明

Kiwi Search 只在用户自己的浏览器中执行，由用户本人或用户自己的 Agent 主动发起；不会自动破解验证码，遇到验证时会把对应页面切到前台交由用户完成；各来源分别排队并限速。搜索引擎服务条款通常禁止自动化查询，这些措施不代表搜索引擎授权。请自行承担使用风险，仅供个人使用，并遵守当地法律及各来源的服务条款。
