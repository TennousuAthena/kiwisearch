# MCP server and bridge

The stdio MCP server, the hub/relay design and the extension side of the bridge. Overview and rules: [AGENTS.md](../../AGENTS.md). Chinese overview for people: [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

## Overview

**`packages/mcp`: stdio MCP server that forwards to the browser.** `src/index.ts` reads or creates the pairing token at `~/.kiwi-search/token` (`KIWI_HOME` overrides the directory). Tools are defined in `src/server.ts` (`search` and `answer` take `mode`).

- `BridgeSession` (`src/session.ts`) owns the link. The first MCP process to start binds `127.0.0.1:17345` (`KIWI_PORT`) and becomes the `BridgeHub`. It accepts the extension at `/extension`, which must present the token and a `chrome-extension://` origin, and relay clients at `/mcp`.
- Any later MCP process gets `EADDRINUSE` and becomes a `RelayClient` that talks to the existing hub. One browser connection therefore serves several MCP clients. The hub remaps request IDs (`routeId`) in `src/bridge.ts`. If the hub process exits, the relays race to bind the port again, so one of them becomes the new hub.
- The extension side is `apps/extension/lib/bridge.ts`. It runs each MCP request through the same `runSearch`, so MCP calls share the UI's queues, rate limits, cache and worker tabs. Hidden (filtered) results are left out of the tool text and listed under `structuredContent.hidden`.
- `answer` fails when the summary provider is `chrome-builtin`, because that model only runs in the new-tab page.
