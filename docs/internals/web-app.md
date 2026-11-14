# Web app, extension interface and the bridge between them

The search interface now exists in two places that share one code base: a static website (`s.kiwi.moe`) that talks to the installed extension, and an interface the extension carries itself. Overview and rules: [AGENTS.md](../../AGENTS.md). The interface itself is described in [newtab-page.md](newtab-page.md); the service worker it talks to in [extension-runtime.md](extension-runtime.md).

This file records the design decisions and what was checked. Status per phase is at the end; a phase that is not listed as done is not built.

## Design decisions (settled 2026-11-14)

- **Two interfaces, one code base.** The search UI lives in `packages/app` and depends only on a `KiwiHost` interface (search and summary streams, site icons, focus a worker tab, block/boost a site, UI preferences, academic language, open settings, open the local interface). The website supplies a `WebHost` (the protocol below); the extension's own page supplies an `ExtensionHost` (the `runtime.connect` and `storage` calls it makes today). The same contract tests run against both.
- **The website is static files.** No back end, no proxy, no analytics, no third-party script. A strict CSP (`connect-src 'none'`) lets anyone check that the page cannot send anything anywhere.
- **The query is never sent to our server.** It travels in the URL fragment, which browsers do not put in the request.
- **The extension no longer takes over the new tab.** `chrome_url_overrides` goes away; each browser's own ways of choosing a start page are written up for users.
- **Settings stay in the extension** (keys, source switches, block lists, MCP pairing); the page never sees them.
- **Interface source** (new setting `uiSource`, `site` by default, `local` for users who do not want to open the website at all). In `local` mode the extension rewrites Kiwi's own search address inside the browser to its own page and refuses every request from the website.
- **The extension toolbar button always opens the local interface.** It is the route that works whatever happens to the website.

## Search URL

`https://s.kiwi.moe/#<params>&q=<query>`. The search box of a browser fills `%s` into the address; for a fragment Chromium percent-encodes spaces (`%20`), `#` (`%23`) and non-ASCII, but **leaves `&` as it is** (checked, see below). So `q` must be the last parameter and its value is the whole rest of the fragment: a search for `a&b=c` arrives as `#q=a&b=c` and must not be split. Addresses the app writes itself put every other parameter (`m`, `lang`, news options) before `q` and encode the query with `encodeURIComponent`. A `+` in the fragment is a plus, not a space. The old `newtab.html?q=…&m=…` form keeps being read.

## Bridge protocol (website to extension)

Not built yet; the shape that was tested in Phase 0:

- A content script on `https://s.kiwi.moe/*` (top frame, `document_start`) sets `data-kiwi="<protocol>"` on `<html>`, so the page knows at its first script whether an extension is there.
- The page creates a `MessageChannel` and hands one end to the content script with `window.postMessage({kiwi:'connect'}, location.origin, [port])`. Everything after that uses the private port; nothing is broadcast on `window`. The content script checks `event.source === window` and the exact origin.
- Messages: `hello` → `welcome {protocol, ext, caps}` or `incompatible`; `{t:'req'|'res'}` for calls; `{t:'open'|'msg'|'close', ch}` for streams, which the content script maps one-to-one to `runtime.connect({name})` ports so the service worker's search and summary handlers stay as they are; `{t:'push'}` for UI preference changes.
- `hello`, `welcome`, `incompatible` and `openLocal` exist from protocol 1 and never change, so any extension can at least send the user to the local interface.
- Versioning: the protocol number only grows on an incompatible change; inside one number things are only added; unknown fields and events are ignored; both sides support the current and the previous number for a release cycle; fixtures of each version's message stream are replayed in CI.
- `externally_connectable` is not used: Firefox does not have it.

## Phase 0: what was checked (2026-11-14)

All runs used throwaway, headless browsers with fresh profiles and random debugging ports, on macOS: Chromium 156.0.8078.79 and Firefox 160.0. The dev browser and its profile were not touched. The probe extension and scripts are not in the repository; they were in `~/.kiwi-search/phase0/` (a small MV3 extension with DNR rules, a content script and a page, plus a CDP harness). Test hosts were mapped to local servers, and all other DNS was refused.

**Checked (Chromium 156):**

- DNR matches the fragment. `regexFilter` `^https://s\.kiwi\.moe/#q=(.*)$` and `urlFilter` `|https://u.kiwi.moe/#q=` both redirected `…/#q=hello%20world` to an extension page, and the local HTTPS server that stood in for the site received no request at all.
- The redirect happens before DNS: `https://local.kiwi.invalid/s?q=abc` (a name that cannot resolve) was redirected to the extension page, for browser-started and page-started navigations alike.
- `web_accessible_resources` is needed only for navigations started by a web page (a link or `location.href`); without it they stop with `net::ERR_BLOCKED_BY_CLIENT`, and nothing reaches the server. Navigations the browser starts (CDP `Page.navigate`, which has no initiator; the omnibox itself was not driven) redirect without it.
- A default search engine with the template `https://s.kiwi.moe/#q={searchTerms}` (declared by an unpacked extension through `chrome_settings_overrides`, then used through `chrome.search.query`) navigated to `https://s.kiwi.moe/#q=hello%20world&x=1%23f%20%E4%BD%A0%E5%A5%BD` for the text `hello world&x=1#f 你好`. The server saw `GET /` only.
- `webNavigation.onErrorOccurred` reports the failed address with its fragment (`https://nope.kiwi.invalid/#q=hello`) and `net::ERR_NAME_NOT_RESOLVED`. The same navigation also produced a `net::ERR_ABORTED` event, and a blocked redirect produced `net::ERR_BLOCKED_BY_CLIENT`, so an automatic fallback has to react to name, connection and timeout errors only.
- `optional_permissions: ["webNavigation"]` is accepted by Chromium with no install warning. Asking for it at run time needs a prompt, which a headless browser cannot answer, so the grant itself was not tried.
- The `MessagePort` bridge (page → content script → `runtime.connect` → service worker) works in both Chromium and Firefox, `data-kiwi` is already set when the page's first script runs, and the handshake took 0.7 to 1.3 ms in most runs and 3 to 5.5 ms on a first call or now and then. Per-event cost, with the sender paced by a busy-wait so no timers are involved (300 events after one 57 KB results event, three runs each): extension page directly p50 0 ms, p95 0.1 ms, max 0.6 to 4.2 ms; through the bridge p50 0 to 0.1 ms, p95 0.1 to 0.2 ms, max 2.6 to 4.1 ms. A burst of 1,500 events took 29 to 41 ms directly and 30 to 33 ms through the bridge. The stream was synthetic (sized like a real result set), not a recorded search. Because of this the planned "merge events every 50 ms" step is not needed.
- Firefox 160 delivers a `MessagePort` transferred by the page to the content script (`event.ports[0]`) and passes the whole stream: handshake 1 to 18 ms, paced events p50 0 to 1 ms, p95 2 to 8 ms, max 15 to 99 ms (its timer is coarsened to whole milliseconds). The fallback to `window.postMessage` of strings is not needed.

**Seen and not explained:** when the stream was paced by `setTimeout(10)` in the service worker and only a web page (not an extension page) was open, the timer fired about every 104 ms, not every 12 ms, so 300 events took 29 s instead of 3.6 s. Delivery delay per event was still small. It did not change with `--disable-renderer-backgrounding`, `--disable-background-timer-throttling` or `--disable-backgrounding-occluded-windows`, and opening an extension page in another window did not help. It was not tried in a headed browser. Nothing in the pipeline paces by short timers (the soft deadline is 6 s), but treat it as open until a real search through the website has been timed in a headed Chromium.

**Not checked:**

- A user adding `https://s.kiwi.moe/#q=%s` by hand in the browser's settings (the `%s` form). Only the `{searchTerms}` template of an extension was tested; the settings page could not be driven headlessly.
- The omnibox itself, including whether it connects ahead to the default search host.
- Whether a `regexSubstitution` result may end in a fragment (the tests redirected to `app.html?…`, not `app.html#…`).
- Firefox DNR (fragment matching, redirects to the extension page) and `webNavigation`: the probe's second background script did not load there and the cause was not found. The repository's Firefox build is MV2; whether `declarativeNetRequest` exists there was not checked.
- Edge (not installed on the machine used), Safari, and official Google Chrome.
- `LanguageModel` (the Prompt API) in a web page: it exists in Chromium 156 but `availability()` answered `unavailable` (the model ships only with Google Chrome), and it does not exist in Firefox. Whether it runs in a page of official Chrome 148 or later was not checked.
- `chrome.permissions.request` for `webNavigation` (see above).

## Phase status

| Phase | State |
|---|---|
| 0. Verify the risky assumptions | done 2026-11-14, record above |
| 1. Shared interface package, extension page unchanged | not started |
| 2. Protocol package and extension side | not started |
| 3. Website | not started |
| 4. Interface source, local mode, fallback | not started |
| 5. kiwi.moe pages, hosting, CI | not started |
| 6. Activate in the user's Chromium and verify | not started |
