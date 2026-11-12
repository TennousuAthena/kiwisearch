# Search pipeline

How `runSearch` runs one search: choosing sources, timeouts and the soft deadline, the event stream, `Env`, and the cache. Overview and rules: [AGENTS.md](../../AGENTS.md). Chinese overview for people: [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

## The flow

**`packages/core`: the search pipeline.** `runSearch` in `src/pipeline.ts` is the whole flow, for one `SearchMode` (`web`, `images`, `video`, `academic`, `zhihu`, `xiaohongshu`, `wechat`, `x`):

- pick usable sources for the mode (`usableSources` in `config.ts`) and query them in parallel, each with its own timeout. A browser source's timeout starts when it calls `onStart` (after queueing and rate limiting), not when it is enqueued. The per-source result count comes from `resultCount` (`perSourceCount`, `imageCount`, `videoCount`, `noteCount`).
- every finished source emits a partial `fused` event; with `softDeadlineMs` set (the new-tab page uses 6s, MCP does not) slow sources are left running and merged later like captcha-blocked ones (`late_results`, emitted after `done`, judged first when the judge is on). The summary is decided once, when the deadline passes: later results never start one. So if a summary is wanted and none of the sources in by then has any text, the deadline keeps waiting for the first source that does (found when a cold start left only DuckDuckGo in at 6 s, and the overview was lost for that search).

## Events and Env

Progress is emitted as `PipelineEvent`s through `onEvent`; the new-tab UI and the MCP bridge both consume that stream. Core never calls `browser.*` directly. The caller passes an `Env` with `fetch`, `cache` and, for browser engines, `runBrowserEngine`. The renderer settings travel inside `BrowserRunOptions`, so one search uses one config snapshot.

## Cache

`Env.cache` (`cache.ts`, 5 min TTL, shared by the new-tab page and the MCP bridge) caches hits per mode/source/count/query.
