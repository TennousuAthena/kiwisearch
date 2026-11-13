# Search pipeline

How `runSearch` runs one search: choosing sources, timeouts and the soft deadline, the event stream, `Env`, and the cache. Overview and rules: [AGENTS.md](../../AGENTS.md). Chinese overview for people: [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

## The flow

**`packages/core`: the search pipeline.** `runSearch` in `src/pipeline.ts` is the whole flow, for one `SearchMode` (`web`, `images`, `video`, `news`, `shopping`, `academic`, `zhihu`, `xiaohongshu`, `wechat`, `x`):

- pick usable sources for the mode (`usableSources` in `config.ts`) and query them in parallel, each with its own timeout. A browser source's timeout starts when it calls `onStart` (after queueing and rate limiting), not when it is enqueued. The per-source result count comes from `resultCount` (`perSourceCount`, `imageCount`, `videoCount`, `noteCount`).
- every finished source emits a partial `fused` event; with `softDeadlineMs` set (the new-tab page uses 6s, MCP does not) slow sources are left running and merged later like captcha-blocked ones (`late_results`, emitted after `done`, judged first when the judge is on). The summary is decided once, when the deadline passes: later results never start one. So if a summary is wanted and none of the sources in by then has any text, the deadline keeps waiting for the first source that does (found when a cold start left only DuckDuckGo in at 6 s, and the overview was lost for that search).

## Events and Env

Progress is emitted as `PipelineEvent`s through `onEvent`; the new-tab UI and the MCP bridge both consume that stream. Core never calls `browser.*` directly. The caller passes an `Env` with `fetch`, `cache` and, for browser engines, `runBrowserEngine`. The renderer settings travel inside `BrowserRunOptions`, so one search uses one config snapshot.

## Cache

`Env.cache` (`cache.ts`, 5 min default TTL, shared by the new-tab page and the MCP bridge) caches hits per mode/source/count/query (and, for an academic source, the language limit). News entries use a 60-second TTL and include the normalized time range and sort order, since a source may send both upstream. `RunOptions.refresh` bypasses cache reads, still writing the new result and respecting browser queues. Cached hits keep their original absolute parsed times and `news.retrievedAt`; a cache hit never makes an old relative label fresh again.

## News snapshots and filtering

News normalizes `RunOptions.news` to `range: any` and `sort: relevance` by default. One `requestedAt` anchors the rolling day/week/30-day-month cutoff for the whole run, including late results. `applyNewsOptions` runs after deterministic domain rules, after judging/reranking, and after every late merge. Date order uses known publication times before unknown ones, with relevance and normalized URL as stable ties. Strict ranges keep out old articles (`hidden: time/outside`) and uncertain publication times (`time/unknown`); a calendar day or rounded age overlapping the cutoff remains uncertain. An explicitly updated/unknown time is not treated as a publication time. Late reporting may be newer than `requestedAt` if it was already published at the source's own capture time. Explicit blocks and user-rule exclusions stay hidden. The judge cannot restore time-filtered articles to satisfy its minimum-visible fallback.

`PipelineResult.news` returns the normalized options and `requestedAt`. When an overview starts, it also records `summaryAt`, before page-text fetching; both API and built-in summaries emit `summary_start` at that point. Citation selection remains fixed for that overview. Late results are still emitted and sorted, but never automatically regenerate its text or renumber its citations. The new-tab consumer can offer an explicit overview refresh; MCP returns its completed snapshot and reports unavailable sources.

Checked 2026-11-13 with mocked sources and a fixed clock: independent cache entries for range/order/mode, explicit refresh, 60-second news expiry versus five-minute web expiry, time filtering through model scoring, date sorting after reranking, partial/late result filtering, and frozen summary citations. These unit tests make no browser or model-service calls; live activation and source markup checks are recorded separately in [news.md](news.md).

## Shopping offers

`shopping` selects only the three shopping browser sources and uses `perSourceCount`. It skips intent routing, academic planning, judging, reranking, page-content fetching and summaries through the existing non-text-mode guards. Domain rules and block lists still apply. Shopping uses URL-only fusion and bypasses Wikipedia folding; matching titles and descriptions across shops never imply the same offer. Partial and late results preserve the optional `product` fields as a single source snapshot, without mixing prices or currencies. The normal five-minute source cache applies. Amazon declares `minTimeoutMs: 60000`; the browser-source wrapper forwards that floor and the pipeline uses `max(config.sourceTimeoutMs, source.minTimeoutMs)`, starting after queueing/rate limiting. Other sources keep the configured timeout. A longer user timeout is retained, while explicit cancellation still aborts immediately. This floor allows cold minimized Amazon pages to finish streaming; it does not delay products already extracted or change the UI soft deadline.

Checked on 2026-11-13 by `shopping-pipeline.test.ts`: source/default isolation, existing choices, separate matching-title offers, product metadata in partial/late merges, and no model calls with all model features configured. Live browser coverage is recorded in [sources.md](sources.md).

## Search recovery and independently cancellable overview

The extension page's port lifecycle lives in `lib/searchSessionController.ts`; `useSearchSession.ts` subscribes React to it. Each search and each explicit summary has an independent port identity. Replacing, stopping or restoring a session invalidates old listeners before closing ports, so late events cannot update the new query. Unexpected disconnects and failed keepalive writes end waiting and preserve partial results with a recoverable interruption. A normal settled port closing is not a failure. `stop()` preserves results and text while clearing running/blocked waits; `restore()` never makes a request and turns unfinished history snapshots into stopped states.

The page reducer retains source counts/errors and full completion statistics. Before a search, the background sends mode-specific enabled/ready counts from `usableSources`, allowing the UI to distinguish missing configuration from a genuinely empty search. This does not change source defaults or the source selection algorithm.

`RunOptions.summarySignal` cancels only the overview, while the existing `signal` still cancels the entire search. The summary stage is shared with `summarizeSnapshot` in `summarySnapshot.ts`; the normal automatic summary timing, source selection and MCP behavior are retained. An overview-only cancellation emits `summary_stopped` and then lets the search finish normally. MCP callers do not supply the extra signal. `onSummarySnapshot` exposes the selected evidence and preparation time to the extension without adding a second source search. Details of retry evidence are in [summary-and-language.md](summary-and-language.md).

Checked on 2026-11-13: mocked port/controller tests cover disconnects before results, after partial results and during summaries, failed keepalives, obsolete query messages, stop/restore without requests, settled disconnects, source diagnostics, summary-only cancellation and built-in streaming cancellation/timeouts. Core summary and news pipeline regression tests pass; core and MCP typecheck pass. These checks use synthetic events and mocked models, not real browser fault injection or provider requests. Final build, live activation and UI integration verification belong to the parent frontend task.
