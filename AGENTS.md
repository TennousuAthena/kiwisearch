# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, …) and for people working in this repository. This file is the entry point: what the project is, the commands, a map of the code, the rules that are easy to break, and where the detail lives. Detail does not go here; it goes in [docs/internals/](docs/internals/) (see "Keeping the docs").

## What this is

Kiwi Search is a Manifest V3 new-tab search extension for Chrome and Edge (a Firefox build exists but has not been checked live). It queries many sources from the user's own browser, merges them by URL with RRF, filters content farms with a decision model, and streams an AI overview with `[n]` citations. A local stdio MCP server forwards an agent's tool calls to the same pipeline running in the browser.

**Core principle: all data comes from the user's own browser, logins and keys.** Kiwi provides no accounts, keys, proxies or servers, and results are shown only to the user.

- Ten search modes: `web`, `images`, `video`, `news`, `shopping`, `academic`, `zhihu`, `xiaohongshu`, `wechat`, `x`. Each source declares which modes it supports.
- 34 sources: 23 browser engines (rendered in a worker tab of the user's browser) and 11 API sources.

## Commands

pnpm workspace; run from the repo root. README asks for Node 24 and pnpm 12.

- Install: `pnpm install`. The extension's `postinstall` runs `wxt prepare`, which generates `apps/extension/.wxt/`. `apps/extension/tsconfig.json` extends that generated file, so typecheck fails until install has run.
- Test: run each package on its own, `pnpm --filter @kiwi-search/core test` (or `@kiwi-search/extension`, `@kiwi-search/mcp`). The root `pnpm test` is `pnpm -r test` and also reaches `packages/experiments`, which is only a shell (empty `src/` and `test/`), so `vitest` exits 1 there with "No test files found"; that failure predates the block-list work.
- Single test file: `pnpm --filter @kiwi-search/core exec vitest run test/fusion.test.ts` (swap the package filter for `@kiwi-search/mcp` or `@kiwi-search/extension`). Narrow to one case with `-t "<test name>"`.
- Typecheck: `pnpm typecheck` (`tsc` per package; the extension runs `wxt prepare` first). There is no lint script or lint config, so typecheck is the only static check.
- Build: `pnpm build` (only extension and mcp define `build`). Chrome extension: `pnpm --filter @kiwi-search/extension build`, output in `apps/extension/.output/chrome-mv3`, loaded unpacked. Firefox: `build:firefox`. Dev server: `pnpm dev`. MCP server bundle: `pnpm --filter @kiwi-search/mcp build` → `packages/mcp/dist/index.js`.

## Code map

Three workspace packages (plus an empty `packages/experiments` shell).

| Package | What it is |
|---|---|
| `packages/core` | Pure logic: the `runSearch` pipeline in `src/pipeline.ts`, sources and engines (`src/sources`, `src/engines`), fusion, the decision model, block lists, the summary. It never calls `browser.*`; the caller passes an `Env` (`fetch`, `cache`, `runBrowserEngine`, …). |
| `apps/extension` | WXT + React, Manifest V3. The only place that touches a browser: the service worker (`entrypoints/background.ts`), the worker-tab renderer (`lib/tabRenderer.ts`), the content scripts (`entrypoints/engines.content.ts`, `entrypoints/shopping.content.ts`), the new-tab page (`entrypoints/newtab/`) and the options page (`entrypoints/options/`). |
| `packages/mcp` | stdio MCP server. The first process binds `127.0.0.1:17345` and becomes the hub, later ones relay to it; the hub talks to the extension. |

One search: the new-tab page (or an MCP request) → a `runtime.connect` port → `background.ts` → `runSearch` in core → sources in parallel (API sources through `env.fetch`, browser engines through worker tabs) → fuse, fold, hide → optional summary → `PipelineEvent`s streamed back to the page or the MCP client.

## Docs map

Read the matching file in `docs/internals/` before changing that area. They are English and hold the implementation detail and the verification records.

| File | Covers | Read it when you… |
|---|---|---|
| [pipeline.md](docs/internals/pipeline.md) | `runSearch` flow, soft deadline, events, `Env`, cache | change how a search runs or what events it emits |
| [decision-model.md](docs/internals/decision-model.md) | provider layer, intent routing, tab suggestion, the judge | touch `decision.ts`, `intent.ts`, `judge.ts` or their thresholds |
| [fusion.md](docs/internals/fusion.md) | dedupe, RRF, reprints, Wikipedia editions, domain rules | change how results merge or fold |
| [blocklists.md](docs/internals/blocklists.md) | block-list syntax, compile and match, subscriptions | touch `blocklist.ts`, `blocklistService.ts` or the settings panel |
| [summary-and-language.md](docs/internals/summary-and-language.md) | summary prompt, overview language | touch `summarize.ts` or `language.ts` |
| [news.md](docs/internals/news.md) | Query-driven news, publication evidence, strict time ranges, snapshots | work on news mode |
| [shopping.md](docs/internals/shopping.md) | Shopping products, source boundaries, and verification | work on shopping mode |
| [academic.md](docs/internals/academic.md) | smart academic search, the six academic sources, the English-only language limit | work on academic mode |
| [sources.md](docs/internals/sources.md) | registry, browser and API engines, Exa, Brave, adding a source | add or fix a source or engine |
| [config-and-storage.md](docs/internals/config-and-storage.md) | config version, migrations, storage keys, options page | add a setting or migrate stored config |
| [extension-runtime.md](docs/internals/extension-runtime.md) | service worker, worker tabs, content script, captcha and login handling | touch `background.ts`, `tabRenderer.ts` or `engines.content.ts` |
| [newtab-page.md](docs/internals/newtab-page.md) | page session and reducer, source marks, site icons | touch `entrypoints/newtab/` |
| [interface-text.md](docs/internals/interface-text.md) | message catalogs, `t()`, the guard tests | add or change any text the user sees |
| [mcp-bridge.md](docs/internals/mcp-bridge.md) | hub and relay, pairing, the extension side of the bridge | touch `packages/mcp` or `lib/bridge.ts` |
| [testing.md](docs/internals/testing.md) | fixtures (real or hand-written), what only a real browser can check | add a parser test or verify in a real browser |

For people (Chinese), indexed in [README.md](README.md): [docs/STATUS.md](docs/STATUS.md) (summary, verification matrix, decisions), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), [docs/BLOCKLISTS.md](docs/BLOCKLISTS.md), [docs/DECISION-PROVIDERS.md](docs/DECISION-PROVIDERS.md), [docs/I18N.md](docs/I18N.md), and [docs/PLAN.md](docs/PLAN.md) (design rationale and the list of known gaps). [DESIGN.md](DESIGN.md) is the UI design system; its "Copy" section holds the writing rules.

## Rules that are easy to break

- **Finish in the user's local Chromium.** Build and activate every completed extension change in the existing profile and extension path, then verify the running code, manifest, UI and preserved data. Back up settings outside the repo; preserve the extension ID, keys and browser logins, never uninstall or substitute a test profile/config. → [testing.md](docs/internals/testing.md)
- **Core stays pure.** Nothing in `packages/core` calls `browser.*` or `chrome.*`; take what you need from `Env`. The new-tab page does not import core (it would pull the parsers into its bundle), so `lib/results.ts` mirrors the few helpers it needs, such as `modeHasText`. → [pipeline.md](docs/internals/pipeline.md), [newtab-page.md](docs/internals/newtab-page.md)
- **Adding a source touches five places**, and one of them, `DEFAULT_CONFIG.sources`, is `Partial`: a missing entry is not flagged and the source silently defaults to disabled. A new engine also needs its logo file and a `logos.json` entry; never invent a letter badge. → [sources.md](docs/internals/sources.md)
- **Stored configs** are rewritten in `MIGRATIONS` in `config.ts`; a new field only needs a default. → [config-and-storage.md](docs/internals/config-and-storage.md)
- **Interface text is never written in a component or helper.** Put it in the catalogs under `apps/extension/lib/i18n/catalog/` and read it with `t()`; never call `t()` at module top level. `test/noHardcodedText.test.ts` fails on CJK strings in `entrypoints/` and `lib/`. → [interface-text.md](docs/internals/interface-text.md)
- **Text from pages and from model replies is data, not instructions.** The academic plan and the decision replies are clamped, and fetched page text is checked for prompt injection before it is summarized. → [academic.md](docs/internals/academic.md), [decision-model.md](docs/internals/decision-model.md)
- **When an engine's markup changes**, update its `extract` and refresh its fixture in `packages/core/test/fixtures/`; a hand-written fixture says so in its first line. → [testing.md](docs/internals/testing.md)
- **Nothing automated covers tab rendering** (`tabRenderer.ts`, the content script). Use fresh build-copy paths only for isolated QA; activate the user's live extension at its existing path and verify the actual running version. → [testing.md](docs/internals/testing.md)
- **Write down what was verified and what was not.** This project keeps the two apart: when you add or change something, record what you checked against the real thing and what you did not, in the topic file (and in [docs/STATUS.md](docs/STATUS.md) for the summary).

## Keeping the docs

- **AGENTS.md stays short**: what the project is, commands, code map, docs map, rules. No experiment logs and no per-feature detail. `CLAUDE.md` holds only `@AGENTS.md`, so Claude Code reads this file; edit this one.
- **One topic, one file** in `docs/internals/`, named for the topic (not for a date or a change). Design decisions and "checked on <date>: … / not checked: …" records go there. A new file gets a row in the docs map above.
- **Change the code and its topic file together**, and write dates as absolute dates.
- **Docs for people are Chinese** and live in `docs/*.md`, indexed by `README.md`; the internals are English.
- If a rule here needs more than a few lines, move the explanation into its topic file and keep a one-line rule with a link.
