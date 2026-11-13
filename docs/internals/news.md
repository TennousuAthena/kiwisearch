# News search

`news` is a query-driven mode between video and academic. An empty tab does not fetch headlines. Existing Google, Brave browser, Brave API and Exa source identities, enabled states and credentials are reused; there is no config migration or separate news subscription. Bing news redirected to its home page in this environment and is not advertised as supported. SearXNG news is deferred.

## Evidence and dates

`NewsInfo` holds publisher, byline, optional thumbnail, original date text, date kind/precision, optional update time and retrieval time. `publishedAt` is only a supported publication timestamp. Relative ages are anchored at extraction and remain fixed in cached hits. Zone-free clock labels stay text; day-only dates never acquire invented hours. Brave's page age can indicate publication or modification and is retained as unknown publication evidence. Retrieval time is never substituted for publication time.

`NewsOptions` defaults to `{range: 'any', sort: 'relevance'}`. Limited ranges are rolling 24 hours, 7 days and 30 days. Sources receive supported native conditions, then the core rechecks publication evidence: out-of-window items are hidden as `time/outside`, unknown or ambiguous boundary dates as `time/unknown`. Unknown dates remain visible for `any`, below known dates when sorting by date. Decision-model minimum-visible recovery cannot restore time-hidden items. Rules are reapplied after fusion, judging, reranking and late merges.

## Fusion, cache and snapshots

News uses normalized URL deduplication and RRF, preserving reports from different media even if their titles or event match. Paper identity, cross-site reprint and Wikipedia-edition folds are disabled. Duplicate URLs retain one coherent article record rather than combining a later date with another record's body; sources/ranks accumulate.

News source cache entries expire after 60 seconds; other modes retain five minutes. Keys include the mode, range and sort so a provider’s native date ordering cannot reuse relevance-only candidates. `refresh: true` skips reads, still writes fresh results and respects worker queues/rate limits. The page has no timer or polling.

The UI's six-second soft deadline still allows late results. AI citations and the summary snapshot are fixed when evidence is selected. The prompt carries publisher, publication/update/retrieval evidence and snapshot time, and asks for attribution and explicit disagreement. Late article evidence changes update the list and mark the overview stale; the user can refresh the whole search. URL state (`m=news`, non-default `range` / `sort`) survives reload and Back, including an empty news tab. MCP uses the same filters and emits snapshot/incomplete metadata; see [mcp-bridge.md](mcp-bridge.md).

## Verification

Checked on 2026-11-13:

- Core full suite: 507 tests passed, followed by the additional Google resolver regression (12 Google tests plus 8 news parser tests passed). Extension: 160 tests; MCP: 16 tests. Together 684 distinct passing cases. Workspace typecheck and both production builds passed. Tests cover strict boundaries, unknown/update dates, cache isolation/expiry/refresh, URL-only fusion, first-text soft deadline, late sorting/citations, reducer stale evidence, URL restoration and MCP metadata.
- Isolated headed Chromium, fresh build path/profile: real Brave news returned 10 results through worker tabs; result cards, publisher/age/thumbnail, idle news URL, no idle query, reload, 24-hour filter request, Back, date ordering request and refresh flag were checked. Desktop and 390 px layouts had no horizontal overflow. Community menus stayed inside 320/375 px viewports and Escape returned focus. Worker windows remained minimized. Google in the fresh profile redirected to `consent.google.com` and correctly failed through the existing handshake error path; no consent choice was made automatically.
- User's original Chromium, ID `kjmchkfoghalbmpfnlehklgfbophhgmp`: actual production worker returned 10 Google news results (11.0 s first search) and 10 Brave results (1.4 s), with hidden worker pages. Google day/date search returned 10 in 2.6 s; all 10 timestamps were within 24 hours and descending, including after the configured judge. Both sources had publishers on all 10; Google had 10 thumbnails, Brave 7. Google links can remain `/goto` wrappers when the resolver cannot obtain a direct URL, so cross-source dedup and article-body retrieval can be incomplete; URLs are not guessed or title-merged. The final day/date sample resolved 1 link and retained 9 wrappers. One retained link was diagnosed read-only: Google returned 302 to RFA, then the destination failed with `ERR_CONNECTION_CLOSED` with either default or included credentials; manual redirects are opaque, so the provider link is retained.
- Authenticated Exa through the user's unchanged existing configuration: 10 news results in 1.9 s, all dated within the requested week and descending. The configured AI streamed an overview with 8 citations and a fixed `summaryAt`. No Brave API key was configured, so that branch has API-contract tests rather than live authenticated verification.
- The MCP tool schema/relay formatting is tested with the fake browser WebSocket; live MCP tools were not called because this profile has no pairing token. Its MCP settings were left intact. Chrome builtin AI, Firefox/Edge and every regional source layout were not checked live.

Activation used the existing loaded path and profile, with storage backed up outside the repository. The running service-worker source hash matched the build; its manifest included Brave's news content-script route and a fresh page displayed News. All 588 pre-existing local storage values, config, bridge and sync storage were byte-semantically unchanged immediately after reload. Normal verification searches subsequently update source-status records. The duplicate extension remains disabled and is not uninstalled. Backup: `~/.kiwi-search/backups/2026-11-12T18-40-12-986Z/`.

Real provider DOM fixtures are distinguished from synthetic edge cases in fixture headers. API fixtures remain synthetic even though Exa was separately checked live.
