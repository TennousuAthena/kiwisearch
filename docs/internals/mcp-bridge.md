# MCP server and bridge

The stdio MCP server, the hub/relay design and the extension side of the bridge. Overview and rules: [AGENTS.md](../../AGENTS.md). Chinese overview for people: [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

## Overview

**`packages/mcp`: stdio MCP server that forwards to the browser.** `src/index.ts` reads or creates the pairing token at `~/.kiwi-search/token` (`KIWI_HOME` overrides the directory). Tools are defined in `src/server.ts` (`search` and `answer` take `mode`).

- `BridgeSession` (`src/session.ts`) owns the link. The first MCP process to start binds `127.0.0.1:17345` (`KIWI_PORT`) and becomes the `BridgeHub`. It accepts the extension at `/extension`, which must present the token and a `chrome-extension://` or `moz-extension://` origin (with `KIWI_EXTENSION_ID`, that exact ID; in Firefox the ID is the per-install UUID shown in `about:debugging`), and relay clients at `/mcp`.
- Any later MCP process gets `EADDRINUSE` and becomes a `RelayClient` that talks to the existing hub. One browser connection therefore serves several MCP clients. The hub remaps request IDs (`routeId`) in `src/bridge.ts`. If the hub process exits, the relays race to bind the port again, so one of them becomes the new hub.
- The extension side is `apps/extension/lib/bridge.ts`. It does not open the socket while the pairing token is empty, so an unpaired browser makes no localhost connection attempts. It runs each MCP request through the same `runSearch`, so MCP calls share the UI's queues, rate limits, cache and worker tabs. Hidden (filtered) results are left out of the tool text and listed under `structuredContent.hidden`.
- `answer` fails when the summary provider is `chrome-builtin`, because that model only runs in the new-tab page.
- `search` and `answer` take an optional `language` (`any` or `en`, academic mode only); the bridge passes it to `runSearch` as `RunOptions.language`, and what the limit hides comes back under `structuredContent.hidden` with the reason `language`. Without it the search is unlimited.

## News tools

`search` and `answer` accept `mode: "news"`, optional `news: {range: "any" | "day" | "week" | "month", sort: "relevance" | "date"}`, and `refresh: true` to bypass source cache reads. The same pipeline validates/normalizes conditions; it does not subscribe or poll. Article details use news publisher/byline and separate publication, update and retrieval evidence, never the generic Zhihu author line. Structured news output includes the `news` snapshot, `incomplete` when any source is blocked/late/failed, and hidden time reasons (`outside` / `unknown`) in both tools. MCP normally waits for sources (no UI soft deadline), but a blocked source can still make the returned snapshot incomplete.

Checked on 2026-11-13: MCP tests verify both tools forward filters/refresh, reject unsupported ranges, retain hidden reasons and snapshot metadata, mark late sources incomplete, and render news authors as news. Live end-to-end bridge verification is recorded in [news.md](news.md).

## Shopping tools

`search` accepts `mode: "shopping"` and forwards optional source selections (`taobao`, `jd`, `amazon`) to the same browser pipeline. Structured results retain the optional `product` object: `thumbnail`, `price`, `shop`, `sales` and `rating`. These are the page's displayed values; the MCP text labels the observed price as such and omits absent fields. It does not infer a missing price or convert currencies. Login and captcha notices use the existing blocked-source reporting. `answer` rejects shopping before sending a bridge request, since product cards are not inputs to the text overview.

Checked on 2026-11-13: all 17 MCP tests passed, including shopping source/mode forwarding, product metadata preservation, display of the observed price, omission of missing prices, blocked-login reporting and rejection of a shopping answer before browser work. This test uses an in-memory MCP client and a stub bridge, not a live paired extension.
