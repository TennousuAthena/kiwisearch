# Browser checks

Scripts that check, in a real browser, what the unit tests cannot: how the extension, the website and the bridge between them behave. They are the checks behind the records in [docs/internals/web-app.md](../../../docs/internals/web-app.md). They are not run by CI and nothing here is a test of the repository's own code in the usual sense.

**Rules.** Every browser these scripts start is a throwaway: a fresh temporary profile, a random debugging port, headless, and all outside DNS refused (only the mapped test hosts and `localhost` resolve), so nothing is sent to a search engine or to `kiwi.moe`. Never point them at your own browser or profile, and do not change them to run headed.

**Needs** Node 24, `openssl` (a self-signed certificate for `s.kiwi.moe` is made on first use and ignored by git) and a Chromium binary: set `CHROMIUM` to it (the default is the macOS app, `/Applications/Chromium.app/Contents/MacOS/Chromium`). Run `node bundle-protocol.mjs` once after `pnpm install` to make `web/protocol.js`, which the test pages load.

| Script | What it checks |
|---|---|
| `chromium.mjs dnr` | `declarativeNetRequest` against addresses with a `#`, a host that cannot resolve, and web-accessible resources, with a probe extension (`ext/`); plus the bridge's cost compared with talking to the extension page directly. `optional` and `dse` check the optional `webNavigation` permission and a default search with a `#` template. |
| `firefox.mjs` | The `MessagePort` hand-over and the stream in a headless Firefox through `web-ext` (install it into `tools/`: `npm install --prefix tools web-ext`). Its DNR self-test did not run, see the record. |
| `smoke.mjs <build> <shots-dir>` | Loads a built extension, opens its search page, settings page and a search, and reports console errors and screenshots. |
| `web-smoke.mjs <build>` | The real protocol client in a page against a built extension (build it with `WXT_KIWI_WEB_DEV_ORIGIN=http://localhost:18765`). |
| `web-e2e.mjs <build> <apps/web/dist> <shots-dir>` | The built website served with its `_headers`, against the extension (same dev origin): a search, a fragment navigation, the service worker and the page opening with the server down, and the page with no extension. |
| `mode-e2e.mjs <build>` | The interface source: the redirects in both modes, the website's handshake, and cutting a connected page when the setting changes (dev-origin build, port 18765). |
| `site-shot.mjs <apps/site/dist> <shots-dir>` | The pages of `kiwi.moe` under their own security policy, at desktop and phone width. |

Results are printed, and some are also written as `results-*.json` (ignored).
