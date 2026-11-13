# Shopping search

Shopping is a standalone mode after News, before Academic. It queries Taobao, JD and Amazon US in the user's own browser using the existing worker tabs, cookies, queues and login/captcha flow. All three source defaults are enabled; only a shopping search uses them. No account, API key, proxy, new configuration field or migration is introduced.

## Results and limits

The optional `product` object carries `thumbnail`, `price`, `shop`, `sales` and `rating`. Each field is source text or a validated image URL. Missing values remain absent. Currency, coupons, variants, regional delivery and account prices are not normalized; Kiwi does not infer the lowest price or stock availability. The card links to the actual product, preserving a known SKU or seller/offer identity. Source markup, URL rules and fixture provenance are documented in [sources.md](sources.md).

Shopping uses URL-only fusion, including partial and late results, so similar product titles from different shops stay separate. It never calls the intent, judgment, reranking or overview models, including when results arrive after login or the soft deadline. Domain preferences and block lists still apply, and hidden products remain expandable. `perSourceCount` and the normal five-minute cache apply.

The page keeps the query while changing modes, supports `m=shopping` URLs, and shows a responsive product grid, original displayed prices and source marks. Empty results and login blocks use the existing status actions. There is no price sorting or generated comparison. Settings group all three sources under Shopping. MCP `search` accepts `shopping` and keeps product metadata; `answer` rejects it because there is no text overview.

## Verification on 2026-11-13

Parser fixtures include eight real Amazon cards and real Taobao/JD login walls. Taobao's initial successful-card fixture is hand-written from its public frontend bundle; a later real `taobao-live.html` capture adds ten products and the observed primary `mainImg--` image selector. JD's successful-card fixture is hand-written against the traditional result markup and does not establish signed-in extraction. The real browser source probe returned 48 Amazon products, showing GBP prices under its current region settings.

Unit coverage includes safe product/image URLs, duplicate and unrelated cards, missing/list-only prices, coupon text, SKU/seller/offer identity, defaults and preserved existing choices, separate shop offers, source restrictions, and immediate/late model-call exclusion. The extension guards cover the catalog, mode order, overview exclusion, source groups and brand assets; MCP tests exercise shopping metadata and refusal of shopping answers.

Final package checks passed: core 539 tests, extension 173 tests and MCP 17 tests (729 total), workspace typecheck, production extension/MCP build, and `git diff --check`.

UI checks used explicitly mocked results with one real product photo, without changing user settings. At 1440px and 390px, light and dark themes had no horizontal overflow or runtime exception. Missing and failed images, absent prices, hidden results, empty results and an idle shopping tab were inspected. The idle tab made no search request. Screenshots and facts are in `/tmp/kiwi-shopping-ui/`.

The first original-profile run exposed a runtime issue despite correct parsing: Amazon’s document stayed in `loading`, so the old `document_idle` entry missed its handshake/deadline. Shopping now has its own early entry and Amazon a 60-second minimum working timeout; other engines retain their startup/timeout behavior. Details and regression checks are in [extension-runtime.md](extension-runtime.md).

The existing Chromium profile (`~/.kiwi-search/dev-profile`), extension ID `kjmchkfoghalbmpfnlehklgfbophhgmp` and loaded directory `/tmp/kiwi-probe/ext-live-1794502531` were retained. The matching Reload button in `chrome://extensions` activated the build. The executing service-worker source hash and complete running manifest were compared with the build, including disjoint ordinary/early shopping content scripts. The settings page showed the shopping group and three source controls.

The live query `wireless headphones` returned 20 product cards from Taobao/Tmall and Amazon, with 19 displayed prices, all 20 thumbnail URLs (18 loaded at capture time; two were still unloaded and all used lazy loading), source logos, original currency/price conditions, no overview and no horizontal overflow. JD reported a login wall. On this later request Taobao returned products without any credential or login-state change by the agent; the result does not establish whether the platform served them due to the existing account or temporary guest access. Earlier same-profile Taobao requests showed a login wall, so availability remains session-dependent.

Storage and the prior build were backed up under `~/.kiwi-search/backups/2026-11-12T18-52-12-502Z/` (directories 0700, files 0600). Saved `config`, API credentials, `bridge` and sync storage were unchanged. Other changed saved entries were `sourceStatus` and favicon caches; the existing favicon service prunes older entries when its cache exceeds 500, retaining 400, and running pages also refresh icon timestamps. No stored settings were replaced, and no profile, site cookies or extension identity were reset. Verification JSON is kept in the protected backup; screenshots and live UI facts are in `/tmp/kiwi-shopping-qa/`.

Not verified: successful JD product extraction, explicit Taobao login completion, live captcha completion, other Amazon country sites or region/layout variants, Firefox, and a live paired MCP client.
