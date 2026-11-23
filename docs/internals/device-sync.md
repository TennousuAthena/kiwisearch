# Device sync (P2P over WebRTC)

Design and implementation record for syncing a user's Kiwi settings between their own browsers, directly from device to device. As of 2026-11-20, the relay (`apps/relay`), the pure sync library (`packages/sync`), the protocol types (`packages/protocol/src/sync.ts`), and the extension integration (`apps/extension/lib/sync*.ts`, `entrypoints/sync-offscreen/`, `entrypoints/options/SyncSection.tsx`) are implemented and covered by unit/integration tests; see [Implementation status (2026-11-20)](#implementation-status-2026-11-20) below for what is verified vs. not yet verified. The feasibility checks of 2026-11-19/20 are scripts in `packages/experiments/browser-checks/`. Overview and rules: [AGENTS.md](../../AGENTS.md). The decision record for people (Chinese) is the "长期方向：设备间 P2P 同步" part of [docs/STATUS.md](../STATUS.md).

## Requirements

Decided on 2026-11-15 (WebRTC as the transport) and on 2026-11-19, when "no server of any kind" was replaced the same day by a relay on these terms:

- **Data goes device to device over WebRTC.** Signaling (finding each other and exchanging connection details) goes through a **relay**.
- **The relay is blind.** Everything it carries is encrypted and authenticated on the devices with keys it never has. It cannot read, forge, alter or replay anything without the devices noticing, and nothing depends on trusting it, its operator or its host. What it unavoidably sees is listed under [What the relay sees and can do](#what-the-relay-sees-and-can-do).
- **The relay stores nothing** (decided 2026-11-19): it forwards frames only between devices connected at that moment, so two devices sync only while both are online.
- **Offline phrase rotations have a bounded rendezvous window:** a device keeps up to three previous non-extractable group secrets for up to 30 days. Relay-only beacons on those old topics carry missing rotation/removal records and their prerequisites; an old topic closes earlier once every attested active member has acknowledged the transition. A device offline longer than 30 days must re-enter using the current phrase.
- **The relay runs on Cloudflare Workers** (`apps/relay`). The project deploys the default at `wss://relay.kiwi.moe`; users can replace it with a self-hosted relay. Leaving the address empty uses [connection codes](#connection-codes-fallback-without-a-relay) only.
- **Identity is a 24-word recovery phrase** that the user keeps safe (the project owner's proposal of 2026-11-19). Entering it on a device joins that device to the group.
- **STUN defaults on for new devices.** Advanced → Sync connection controls the switch and server list. A stored false is preserved.
- **Otherwise Kiwi's principle holds:** no accounts, nothing on `kiwi.moe`; the website and its bridge never touch sync.

Not goals for the first versions: phones and Safari (no Kiwi client there yet), syncing when the devices are never online at the same time (the relay holds nothing; only the encrypted export file of phase 4 helps there), browser logins and cookies (they belong to the browser profile, not to Kiwi), and search history (Kiwi does not persist query text today).

## What syncs

Synced data is a set of registers keyed by a path. Each path belongs to one category; the user turns categories on per group. Everything not listed is device-local and never leaves the device.

| Data (storage key, path) | Category | Default | Notes |
|---|---|---|---|
| `config.sources.<id>.enabled`, `.weight`, `config.sources.searxng.baseUrl` | Search settings and sources | on | The SearXNG address can sync without its optional API key, including when the address is reachable only on the local network. |
| scalar search settings in `config` (counts, timeouts, `judge` thresholds and `rules`, `intent`, `academic`, `rerank.provider`, model names, `summary` except keys, the Wikipedia folding choice) | Search settings and filters | on | `judge.rules` is an ordered list of sentences and syncs as one value. |
| `config.judge.blockedDomains`, `boostedDomains` | Site preferences | on | One register per domain holding `block`, `boost` or `none`, which keeps the existing rule that a domain is never both (see [config-and-storage.md](config-and-storage.md)). |
| `config.judge.blocklists`: `recommended`, `subscriptions`, `custom` | Block lists | on | One register per recommended id and per subscription id; `custom` is one text value. Only the subscriptions sync, not the fetched lists (`blocklistMeta`, `blocklist:<id>`): each device fetches them itself, which means turning on sync makes the other device request those third-party hosts too, and the settings panel says so. |
| `ui:theme`, `ui:summaryMode`, `ui:openNewTab`, `ui:recentQueries`, `academicLanguage` | Interface | on | |
| `config.*.apiKey`, `config.sources.<id>.apiKey` (including SearXNG), other custom endpoint addresses (e.g. `config.llm.baseUrl`, `config.judge.endpoint`, `config.judge.llm.baseUrl`) | Keys and endpoints | **off** | Turning it on asks for a separate confirmation on each device. |
| `bridge` (MCP pairing token and port), `onboarding`, `uiSource`, `uiFallback`, `sourceStatus`, `blocklistMeta`, `blocklist:<id>`, favicon cache, `domainPreferenceRevisions`, `config.renderer.*`, `config.version`, session storage | Device-local | never | The MCP token pairs this browser with a process on this machine; the rest describes this device or is a cache. `domainPreferenceRevisions` are local undo receipts: a remote change to a domain invalidates them the same way a local edit does. |

## Feasibility checks (2026-11-19)

Scripts: `webrtc-check.mjs`, `firefox-webrtc.mjs` and the probe extension `ext-webrtc/` in `packages/experiments/browser-checks/` (README there). Throwaway headless browsers with fresh profiles on one Mac; nothing ran in the user's browser profile, and no request went to any STUN or other outside server. Chromium 156.0.8078.79 and Firefox 160.0.

**Checked in Chromium 156 (two separate headless browser processes on one machine, each with the probe's offscreen document):**

| Question | Result |
|---|---|
| WebRTC in the MV3 service worker | No: `RTCPeerConnection`, `RTCDataChannel` and `RTCCertificate` are `undefined` there. |
| Offscreen document with reason `WEB_RTC` | Works. `chrome.offscreen.Reason` lists `WEB_RTC`; the document shows up as a `background_page` target. |
| A connection with no STUN, TURN or signaling server | Yes. Only the compact codes crossed between the two browsers (script standing in for the user); ICE picked a host pair, DTLS 1.3 (`tlsVersion` `FEFC`, `TLS_AES_128_GCM_SHA256`), the channel opened 4 ms after the answer was applied. The candidates were 3 IPv4 and 2 IPv6 host addresses; the second run picked IPv6. |
| Compact code instead of the full SDP | Works: a description rebuilt from ICE username/password, the SHA-256 fingerprint and the UDP candidates (role implied: offer `actpass`, answer `active`) was accepted on both sides. Full offer SDP 1680 bytes, compact JSON 325 bytes; binary form estimated below. |
| Certificate pinning | `RTCDtlsTransport.getRemoteCertificates()` works; the SHA-256 of the peer's certificate equals the fingerprint the code carried, on both sides. |
| Long-lived DTLS certificate | `generateCertificate` with `expires` of 10 years gave **365 days**: Chromium caps it. The `RTCCertificate` survives IndexedDB and a closed and reopened offscreen document with the same fingerprint. |
| Does the channel outlive the service worker? | Yes. After 45 s with no debugger attached, the service worker had been stopped (no longer listed), the offscreen document was still there and the channel still answered a ping (1 ms). The offscreen document can wake the worker with `runtime.sendMessage`. |
| SDP munging | Rewriting `a=ice-ufrag`/`a=ice-pwd` in the local description is accepted and used; rewriting the fingerprint is rejected (`InvalidModificationError`). |
| One-way reconnection | Works on one machine: only the offerer's code crossed; the answerer set its own derived ICE credentials, the offerer built the answer itself from those credentials and the pinned fingerprint, and learned the answerer's address from its incoming checks (remote candidate `prflx`). Opened 7 ms after the synthesized answer. |
| WebCrypto for the key layer | Ed25519 sign/verify, X25519 key agreement, HKDF to AES-256-GCM, and a non-extractable `CryptoKey` round trip through IndexedDB all work in the service worker and in the offscreen document. |
| Addresses in the code | The offscreen document's candidates carried real local addresses (no mDNS `.local` names). An ordinary page in the same headless browser gathered no candidates at all (about:blank, `http://127.0.0.1`, a mapped `https` host), so the extension context differs from a page here; why the page gathered nothing was not investigated. |
| A person is slow to carry the codes | Still connects. Two codes: B answered at once and kept checking (`connecting`), A applied the reply 15, 45 and 90 s later, and the channel opened 3 to 66 ms after that. One code: A waited with the answer already built (`new`) and B used A's code 15, 45 and 90 s later; all opened. This was without a NAT between the two; [w3c/webrtc-pc#2945](https://github.com/w3c/webrtc-pc/issues/2945) reports slow manual signaling failing in general, so the two-device check repeats it across a NAT. |
| Data channel | `maxMessageSize` 262144. 4 MiB in 16 KiB messages took 3.8 s (untuned; settings are kilobytes). |

What the documentation says matches: an offscreen document only closes by itself for `AUDIO_PLAYBACK` ("all other reasons don't set lifetime limits"), one per extension, Chrome 109 and later, also in Edge, not in Firefox ([chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [Edge API support](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)). `RTCPeerConnection` is exposed to windows only; creating it in workers has been an open proposal since 2021 ([w3c/webrtc-extensions#77](https://github.com/w3c/webrtc-extensions/issues/77)). The 365-day cap is in the specification's own limit and in both engines' code, and `RTCCertificate` is serializable for IndexedDB but usable only by the origin that made it. Chromium's WebRTC library turned DTLS 1.3 on by default on 2026-04-06 (commit `e3db08543b`); Firefox did in 127. The `offscreen` permission shows no install warning ([permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)).

**Checked in Firefox 160 (headless, the probe as an MV2 background page installed through WebDriver BiDi):** `RTCPeerConnection` exists in the background page; Ed25519, X25519, HKDF/AES-GCM and a non-extractable key in IndexedDB work; `expires` is capped at 365 days as in Chromium; an `RTCCertificate` survives IndexedDB; munging behaves as in Chromium (ICE credentials accepted, fingerprint rejected); `getRemoteCertificates` exists. Host candidates were mDNS names (`.local`) in the background page.

**Not established in Firefox:** a connection. Two connections in the same background page stayed in ICE `checking` with every pair `in-progress`, with the compact codes and with full descriptions alike, with mDNS names on or off (`plain`), with or without the dead proxy (`noproxy`), and the same happened in an ordinary page of that browser. So this is the environment of the headless Firefox on this machine, not an extension limit, but its cause was not found (macOS Local Network permission is a guess, not checked). Elsewhere, Tor's Snowflake add-on runs its peer connections in a Firefox MV2 background page, and Firefox can switch WebRTC off entirely (`media.peerconnection.enabled`, also settable by extensions through `privacy.network.peerConnectionEnabled`); the panel has to say so when `RTCPeerConnection` is missing.

**Not checked at all:** two real devices; different networks; any STUN server; NATs; Edge; Windows and Linux; a headed browser; a browser with a privacy extension that restricts WebRTC; the macOS Local Network prompt; offscreen lifetime over hours or across sleep. The two-device check is the next step: `ext-webrtc/pair.html` lets a person carry the codes between two devices (tested only between two headless browsers on one machine, where it connected).

## Architecture

```
 options page / Kiwi interface ──runtime messages──▶ service worker (lib/sync/service.ts)
                                                       │  owns sync state (IndexedDB), applies remote changes
                                                       │  through the serialized settings writer (backgroundConfig.ts)
                                                       ▼
                         Chrome/Edge: offscreen document (WEB_RTC)    Firefox: background page
                         RTCPeerConnection + data channel, relay WebSocket, framing, no sync logic
                                │                                      │
             encrypted signaling frames (wss)            DTLS 1.3 data channel, direct device to device
                                ▼
                 relay: Cloudflare Worker + Durable Object per topic, forwards opaque frames
```

- **Transport host.** Chrome and Edge cannot run WebRTC in the service worker, so the peer connection lives in the extension's single offscreen document; it outlives the worker (checked above). Firefox's MV2 background page can hold it directly (API checked; connection not checked). The first prototype needs neither: it runs the whole session inside the sync panel of the options page, which is an ordinary extension page on every browser, and syncs while that page is open.
- **Logic stays out of the transport.** The offscreen document only moves encrypted frames; the sync state machine, keys and the CRDT live in a new pure package (`packages/sync`, WebCrypto only, testable in Node 24, which has Ed25519 and X25519), used by the service worker. The transport can then be swapped (export file, a later LAN helper) without touching the sync layer, as the 2026-11-15 decision required.
- **One writer.** Remote changes are applied through `backgroundConfig.ts`, the existing single serialized writer of `config`, and the preference keys through the same storage they already use. Applying a remote change records it as already synced so it does not echo back. Only the extension's own pages may send sync messages (the same check as `kiwi:update-settings`); content scripts, the web bridge and MCP clients cannot.
- **One offscreen document per extension.** Kiwi does not use offscreen documents today; a later feature that needs one must share this document (a document can list several reasons).

## Recovery phrase

- **What it is:** 256 random bits from `crypto.getRandomValues`, written as 24 words with the BIP39 encoding: 11 bits per word, 256 bits plus an 8-bit SHA-256 checksum, so a mistyped word is caught. Only the encoding is borrowed. The words never go through BIP39's wallet seed derivation, and the panel says that this is a Kiwi sync phrase, not a cryptocurrency wallet, and must not be entered anywhere else. The BIP39 document has been MIT-licensed since 2025-02 (its wordlists have no separate license file and are presumed covered by it); there are lists in ten languages, including Simplified and Traditional Chinese, one character per word. The panel shows English words by default and the Simplified Chinese list in a Chinese interface (24 characters); both encode the same bits, and joining accepts either. Brave appends a 25th word that changes daily so that a code left on screen expires within a day ([`time_limited_words.cc`](https://github.com/brave/brave-core/blob/master/components/brave_sync/time_limited_words.cc)); Kiwi's phrase is meant to be written down and kept, so it has no such word.
- **Keys from it:** the entropy is imported as a non-extractable HKDF key. HKDF-SHA-256 with separate labels gives the topic key (relay topic ids), the signal key (AES-256-GCM over relay frames and connection codes), the record key (AES-256-GCM over change records) and the member key (HMAC proving membership in the handshake). It is already 256 random bits, so no password stretching (PBKDF2, scrypt) is needed.
- **Storage:** devices keep only the non-extractable derived keys in IndexedDB, never the words. So the phrase cannot be shown again: it is shown once when the group is created, with a check that the user wrote it down (enter three of the words), and any device still in the group can make a new phrase if the paper is lost (see [Removing a device](#removing-a-device)). Whether to keep a way to show it again is an open decision. Non-extractable keys cannot be exported by scripts; that does not protect against someone who copies the browser profile from disk.
- **Joining:** on a new device, open the sync panel, choose to join, and enter the 24 words. The device derives the keys, joins the relay topic, finds the other devices and syncs. There are no codes and no safety number, because only holders of the phrase can produce frames the others accept.
- **The cost, accepted:** the phrase is a permanent master key. Anyone who learns it can join and read everything synced, including API keys if that category is on. Losing every device and the paper loses the synced settings. The panel says both plainly when it shows the phrase.

## Signaling through a relay

### Protocol

- **Topic:** devices meet in a topic whose id is `base64url(HMAC(topic key, "day:" + UTC day number))` cut to 16 bytes, 22 characters. The relay sees a new random-looking id every day and cannot link two days' ids, or an id to a phrase, without the phrase; the connecting IP addresses can still link them. For the first 10 minutes after midnight UTC a device also listens on the previous day's topic, so devices whose clocks differ a little still meet.
- **Previous-epoch rendezvous:** the extension retains at most three previous non-extractable HKDF secrets for 30 days and opens one relay-only WebSocket for each retained epoch, using its epoch-specific keys and daily topic. A legacy session authenticates only an already-known, attested, non-removed member whose signing key matches; it accepts no inbound records, only version vectors and acknowledgements. In response to a peer's vector, it sends only its own missing old-epoch `epoch-rotate`/`member-remove` records and their prerequisites—never newer-epoch records or snapshots. Every 30 seconds the client sends an encrypted directed `hello` to each relay peer; a peer with no inbound frame for 90 seconds is expired. Previous topics close when all attested active members' acknowledgement vectors cover the transition record, or when the key is pruned. Devices offline for more than 30 days must join with the current phrase.
- **Frames:** `nonce (12) || AES-256-GCM(signal key, padded message, associated data = topic id)`. A message is JSON (`type`, `from`, `to`, `id`, `t`, `body`) padded to 1536 bytes, so every frame is 1564 bytes whatever it carries. A device drops frames that fail to decrypt, repeat an id it has seen (its own included), or are more than 2 minutes old.
- **Messages:** `hello` (I am here), `here` (the reply), then `offer` and `answer` carrying the compact connection details (ICE credentials, DTLS fingerprint, UDP candidates), and later ICE restarts. Because the fingerprint travels inside authenticated encryption, the relay cannot put its own in and sit in the middle of the WebRTC connection; the signed handshake in the channel checks the peer again.
- **The relay** (`apps/relay`, about 100 lines in `src/index.ts`): a Worker that sends `GET /v1/<topic>` WebSocket upgrades to one Durable Object per topic. The object accepts them with the Hibernation API and forwards each binary frame to the other sockets of the topic, never back to the sender. It does not parse, log or store frames and makes no outgoing requests; a socket that connects later gets nothing that was sent before.
  - Limits (`src/limits.ts`): binary frames of at most 16 KiB (1009 otherwise; signaling frames are 1564 bytes, the margin leaves room for [relayed records](#when-a-direct-connection-fails)); 100 frames per socket per 10 s (1008); 8 sockets per topic (429); text closes the socket (1003), except `ping`, which the runtime answers with `pong` without waking the object, so keepalives cost nothing.
  - Only extension pages may connect: an `Origin` that is not `chrome-extension://`, `moz-extension://` or `safari-web-extension://` gets 403, so no web page, the Kiwi website included, can use it from a browser. This is hardening, not authentication; clients outside a browser can omit or forge the header.
  - `GET /v1/health` answers `{ service, protocol: 1, limits }`, for the settings panel to test an address.
  - Workers Logs are turned off in `wrangler.jsonc`. Cloudflare, as the host, still sees connection metadata whatever the code does.
- **Where the socket lives:** next to the peer connection, in the offscreen document (Chrome, Edge) or the background page (Firefox); in the first prototype, the options page.

### What the relay sees and can do

| | |
|---|---|
| Sees | The topic id of the day; the IP addresses of the connecting devices (and so their rough location and network); when they connect and for how long; how many devices are in a topic; how many frames pass (all the same size). Its host sees the same. |
| Cannot | Read any message, candidate, address or fingerprint; produce or replay a frame the devices accept; learn the phrase or link topics to it; see synced data, which does not pass through it today and, with the [proposed fallback](#when-a-direct-connection-fails), would pass only encrypted. |
| Can | Drop or delay frames, refuse service, disappear. Devices then fall back to connection codes. |

### Checked locally (2026-11-19)

`relay-check.mjs`, first against an experimental copy of the relay: the Worker ran in Cloudflare's own runtime (`workerd` 2026-11-18, through `wrangler dev --local` 4.165.0), nothing deployed. Two throwaway headless Chromium 156 browsers ran the encrypted signaling (`ext-webrtc/relay-probe.js`) in their offscreen documents, with a random 32-byte secret standing in for the phrase. A third client joined the same topic and so saw exactly what the relay sees.

- Both derived the same 22-character topic id. The data channel opened 233 ms after the first `hello` (host IPv4 pair, DTLS 1.3), and the peer's certificate matched the fingerprint from the encrypted answer.
- The relay carried 4 frames, all 1564 bytes. None contained any of the plaintext markers searched for (`candidate`, `ufrag`, `fingerprint`, `offer`, `answer`, `hello`, the device names, `typ host`, `sha-256`) or anything shaped like an IPv4 or IPv6 address.
- From the relay's position, the spy resent all 4 frames, flipped one bit in one, and sent a random frame of the same size. Both devices rejected every one (4 replays and 2 failed decryptions each), and the channel stayed open.
- The relay closed a text frame and a 5000-byte frame with code 1003 (that experimental copy allowed 4096-byte frames; `apps/relay` allows 16 KiB and answers 1009 to larger ones).
- After the sockets had been idle for 75 s, a new frame was still forwarded and the channel was still open (second run, which repeated all of the above with the same results; the channel opened in 228 ms). Whether the local runtime evicted the object from memory in between was not observed.

The same check was run again against `apps/relay` once it replaced the experimental copy: the same results (channel open in 237 ms, 4 frames of 1564 bytes with nothing readable, every replay and forgery rejected, forwarding after 20 s idle), and a 16,385-byte frame was closed with 1009.

**Three devices online at once (2026-11-20).** The probe first kept one connection per device, so when a third device joined a topic, an existing peer's connection was closed and replaced (seen with two Chromiums and a Firefox, and reproduced with three Chromiums: one device's channel went to `closed`). The relay was not at fault; it only forwards. `ext-webrtc/offscreen.js` now keeps one connection per peer, and `ext-webrtc/relay-probe.js` negotiates per peer: the device with the smaller id makes the offer (the other replies `here` to a `hello`), and an answer names the offer it replies to (`re`), still inside the encrypted envelope. `relay-mesh-check.mjs` checks this with three throwaway Chromium 158 browsers (headless) against `apps/relay` in local `workerd`, and passed five runs in a row:

- A and B connect; C joins; all three pairs are open with matching certificates, and the A-B connection is the same one as before (its channel-open timestamp did not change).
- Bytes sent to one peer arrived only at that peer.
- B's browser was closed and a new one joined under the same device name: all pairs open again, and the A-C connection was kept.
- All three sent `hello` at the same moment: all pairs stayed open and no device logged a failed negotiation.

`relay-check.mjs` was run again afterwards with the same results as above. At that time, more than three devices, devices on different networks, Firefox in the three-device check, and a deployed relay had not been checked. The production relay checks are recorded under [Implementation status](#implementation-status-2026-11-20). `lib.mjs` now finds the test extension's service worker by the id Chromium derives from its path, because Chromium 158 also lists a built-in extension's `background.js`.

**End-to-end run of 2026-11-19, from a clean copy.** To check what CI would do, the files a commit would contain (tracked and untracked, ignored ones left out) were copied to an empty directory, and there, under Node 24 (CI's version; the development machine has 26) with pnpm 12: `pnpm install --frozen-lockfile` (the `workerd` install script is allowed in `pnpm-workspace.yaml`), typecheck, the tests of core, protocol, app, extension, web, mcp and relay (632, 35, 164, 166, 54, 18 and 13 tests), the mcp, web and relay builds, `check:dist` of the web build, and the extension builds for Chrome, Edge and Firefox all passed, and `relay-check.mjs` ran there with the results above. The extension's manifest has no relay or offscreen entry, as expected.

Two things the unit tests only covered at the header level were then run in real browsers against the local relay:

- **Web pages are refused.** Chromium 156 pages at `https://kiwi.moe` (mapped to a local server) and at a plain `http://127.0.0.1` address both failed the handshake with `Unexpected response code: 403` (Chromium's own console line, which tells the relay's refusal apart from the browser blocking the page). The extension pages of the same check connected. This is `relay-check.mjs`.
- **Firefox 160.** A Manifest V2 background page (`moz-extension://…`) opened two sockets to the same topic, a 1564-byte frame arrived unchanged at the other socket and was not echoed to the sender; an ordinary web page of the same browser was refused (1006). Only WebSockets are involved, so this does not depend on what stopped Firefox's peer connections on this machine. This is `firefox-relay.mjs`.

**`apps/relay`'s own tests** (`pnpm --filter @kiwi-search/relay test`, 13 tests, wrangler 4.162.0 with `workerd` 1.20261113.1; in CI too) start the Worker in a local `workerd` through wrangler's test harness and talk to it with plain WebSockets: the health route, 404/405/426 for wrong requests, 403 for web origins and 101 for extension origins, forwarding unchanged to the other sockets only and to no other topic, nothing delivered to a socket that joins later, ping/pong, forwarding after the object is evicted with its sockets hibernated, each limit, no log lines while forwarding, and a source check that the code has no storage, logging or outgoing calls. Mutation checks on 2026-11-19: logging each frame, echoing frames to the sender, keeping frames in memory for later sockets, and plain `accept()` instead of hibernation each made the matching tests fail.

The deployed Worker was checked on 2026-11-20 as recorded under [Implementation status](#implementation-status-2026-11-20). Cloudflare's quotas in practice, two real devices, reachability from mainland China, idle periods of hours, and many topics at once remain unchecked.

### Relays that run on Cloudflare Workers (researched 2026-11-19)

Repositories and documentation read on 2026-11-19, nothing deployed or signed up for. "None found" means none found by searching, not that none exists.

| Option | What it is | Fit |
|---|---|---|
| This design's relay (`apps/relay`) | About 100 lines: one Durable Object per topic, forwards opaque binary frames, stores nothing | **Built.** Checked and tested locally above; has nothing to trust and nothing to strip. |
| Nostr relays: [Nosflare](https://github.com/Spl0itable/nosflare) (MIT, last commit 2026-06-18), [snowflare](https://github.com/SnowCait/snowflare) (MIT), [cfrelay](https://github.com/haorendashu/cfrelay) (GPL-3.0) | General Nostr relays. Nosflare keeps events in D1 and sockets in SQLite Durable Objects; its README recommends the paid plan; pay-to-relay is on by default | They store every event, and even with encrypted content the relay sees each event's public key, kind, tags and time. Nostr signs with Schnorr over secp256k1, which WebCrypto lacks, so a library would be needed. The gain, working with public Nostr relays, is not something the requirements ask for. |
| [Trystero](https://github.com/dmotz/trystero) (MIT, 0.27.0 of 2026-11-11) | Client library. Since 0.24.0 it ships a self-hosted `ws-relay` (Node 22 and later, JSON subscribe and publish); no Workers deployment, though its docs say a custom strategy over Durable Objects takes about 30 lines | Its signaling encryption rests on a room password (without one, anyone who knows the app and room ids derives the key), and its default STUN servers must be overridden. Its relay protocol is small enough for this design's relay to speak it later, if Trystero is ever used. |
| PeerJS server | Only a two-commit draft port from 2023 with no license ([peerjs-server-cf-worker](https://github.com/jonasgloning/peerjs-server-cf-worker)) | Not usable as is; see the PeerJS evaluation below. |
| y-webrtc signaling | One-commit CC0 port on Durable Objects ([tt-signaling-cloudflare](https://github.com/sjbrown/tt-signaling-cloudflare), 2026-08-24); y-webrtc itself last changed in 2024-04 | Unmaintained. |
| WebTorrent tracker | None found that serves WebSockets on Workers | None. |
| MQTT (Cloudflare Pub/Sub) | The private beta ended on 2025-08-20 without reaching general availability; its docs were removed in 2025-12 | Gone. |
| Plaintext signaling Workers, e.g. [webrtc-signaling-worker](https://github.com/usherzhao/webrtc-signaling-worker) (no license) | Forward offers and candidates in clear | Fails the requirements. |
| [PartyServer and partysub](https://github.com/cloudflare/partykit) (ISC, Cloudflare's since buying PartyKit in 2024, last commit 2026-08-03) | Cloudflare's library for Durable Object rooms | A possible base for `apps/relay` if it grows; not needed at 100 lines. |

**Free plan (Cloudflare docs as of 2026-11-19).** Durable Objects are on the Free plan since 2025-04-07, SQLite-backed only, which is what `apps/relay` declares (`new_sqlite_classes`). Workers allow 100,000 requests a day and 10 ms of CPU per invocation; Durable Objects allow 100,000 requests and 13,000 GB-s of duration a day. A WebSocket upgrade counts as one request; incoming WebSocket messages to a Durable Object count 20 to 1, outgoing ones are free; a hibernating object is not charged for idle time. Counters reset at 00:00 UTC, and over the limit requests fail (error 1027). A sync meeting is two connections and four frames, a few requests, so the free plan covers thousands of meetings a day. It also means that anyone flooding a public relay can use up its day; codes still work then. The docs do not say whether the 20-to-1 ratio applies to the free daily cap. ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/))

**Deploy button.** Cloudflare's "Deploy to Cloudflare" button (since 2025-04-08) clones a public GitHub or GitLab repository into the user's account and deploys it through Workers Builds, creating the Durable Object binding. The user needs a Cloudflare account and a GitHub or GitLab account. The docs say nothing about plans; it should work on Free with SQLite-backed objects, not tested. ([docs](https://developers.cloudflare.com/workers/platform/deploy-buttons/))

**Mainland China.** GreatFire reports `workers.dev` blocked: all of its last 6 conclusive tests failed, the last on 2026-11-10, with interference recorded since 2022-01-02 ([GreatFire](https://en.greatfire.org/workers.dev)). User reports (anecdotal, 2022–2023) describe blocking by SNI and say a custom domain on Cloudflare works but can be slow or unstable; no recent measurement was found. The project therefore uses the custom domain `relay.kiwi.moe`; reachability from mainland China has not been verified, and connection codes remain the fallback.

### Deploying

The project runs the default relay at `wss://relay.kiwi.moe` on its Cloudflare account. The extension uses this address by default, and users can replace it or leave it empty for codes-only pairing. Forks deploying to their own Cloudflare account must change or remove the `relay.kiwi.moe` custom-domain route in `apps/relay/wrangler.jsonc`.

1. A Cloudflare account (the Free plan is enough, see above) and `pnpm install` in this repository.
2. For a fork, change or remove the `relay.kiwi.moe` route in `wrangler.jsonc`; if needed, add a custom domain of your own.
3. `pnpm --filter @kiwi-search/relay exec wrangler login`, then `pnpm --filter @kiwi-search/relay run deploy`. It needs no secrets: the relay holds no keys.
4. Enter the address (`wss://…`) in each device's sync panel; the panel checks `/v1/health`.

A deploy button would need the relay in a public repository of its own or a monorepo path the button supports; not set up.

## Connection codes (fallback without a relay)

When no relay is set or none answers, the user carries the same messages as codes: `kiwi1-` and the base64url of an encrypted message, sized to its content. Both devices hold the phrase, so every code is encrypted from the first one, and whoever carries it sees nothing about the devices.

1. A: **sync by code** shows an offer code: a 4-byte group hint, a 12-byte nonce and, encrypted with the signal key, A's device id, a timestamp, A's ICE credentials, fingerprint and candidates.
2. B pastes it and shows an answer code; the user pastes that on A, and the channel opens.
3. One-code variant: both derive this session's ICE credentials from the signal key and the nonce, B answers with them, and A builds B's answer itself from them and B's pinned fingerprint. B's checks reach A, A learns B's address from them, and one paste is enough. If nothing opens within about 5 s, B shows its answer code after all.

The one-way path works when B can reach one of A's candidates directly: the same LAN, a public IPv6 address that the firewall lets through, or a NAT that accepts packets from any sender. It depends on rewriting the local ICE credentials, accepted in Chromium 156 and Firefox 160 (checked above), and **Chromium intends to stop accepting that**: an announcement of 2025-04-11 says changed `ice-ufrag`/`ice-pwd` "will be rejected", the WebRTC code has the rejection behind a field trial (`WebRTC-NoSdpMangleUfrag`, off by default in that commit), and "Disallow SDP munging in SetLocalDescription" is a proposed feature with `ice-pwd` among the first candidates ([announcement](https://groups.google.com/g/discuss-webrtc/c/PIJZN5MTZF4), [chromestatus](https://chromestatus.com/feature/5166153227567104)). Whether Chrome stable has switched it on remotely could not be confirmed. So the one-code path is an optimization only: the panel tries it, and the two-code path must always remain and be tested on its own. The independent QWBP draft (2026-01-19) derives ICE credentials the same way for QR pairing and carries the same risk ([spec](https://magarcia.github.io/qwbp/spec.html)).

Codes expire after 10 minutes and are used once.

### Keeping the connection

Once connected, Chrome and Edge keep the channel in the offscreen document while both browsers run, and changes are pushed as they happen (phase 3). A network change breaks the path; if the channel is still alive, an ICE restart is negotiated over the channel itself, otherwise the devices meet again through the relay (or with codes when there is none). The document is closed after a configurable idle time so it does not hold memory forever.

### Code format

Binary, then base64url with a `kiwi1-` prefix so the panel can tell a code from other pasted text. Candidate entries: one byte for the kind (host or server-reflexive; IPv4, IPv6 or mDNS name), the address (4, 16 or 16 bytes, an mDNS name being a UUID) and the port (2). TCP candidates are left out.

| Code | Contents | Size with the checked candidate set (3 IPv4 + 2 IPv6) |
|---|---|---|
| Offer or answer | header 1, group hint 4, nonce 12, encrypted (device id 8, time 4, ufrag 1+4, password 1+24, fingerprint 32, candidates 1+59), GCM tag 16 | 167 bytes, 229 characters |
| One-code offer | header 1, group hint 4, nonce 12, encrypted (device id 8, time 4, candidates 1+59), GCM tag 16 | 105 bytes, 146 characters |

All fit a QR code easily. Showing a QR code is simple; reading one on a desktop is not: `BarcodeDetector` exists in Chrome only on macOS, ChromeOS and Android, in Edge only on macOS, not in Firefox, so scanning would need a JavaScript decoder and camera permission. Text codes come first. The probe's own JSON code (`pair.html`) is 450 characters, unencrypted, and is not this format.

### Evaluated: PeerJS (2026-11-19)

Superseded the same day by the relay above, which does the same job with nothing in clear; kept for the record.

Asked after it became clear that no browser framework finds peers without a server: every one that works in a browser (Trystero, PeerJS, y-webrtc, libp2p, WebTorrent) uses one, because a browser cannot listen, broadcast or use mDNS, and the ones without a central server (Hyperswarm, LocalSend, Syncthing) need raw sockets. PeerJS would let devices that share the group key find each other at ids derived from it, with no code. Using it reverses the "no server" constraint above; no decision has been taken.

Facts (package and source read, `peerjs-check.mjs` run against a **local** PeerServer, never `0.peerjs.com`):

- **State of the project:** `peerjs` 1.5.5 (2025-06-07; later commits are dependency bumps), MIT, 206 open issues; the server package `peer` 1.0.2 (2023-12-05), its 1.1.0 release candidate unreleased since 2024-05. The client bundle is 87 KB, 23 KB gzipped. The default server is `0.peerjs.com:443` with key `peerjs`; neither repository names its operator, gives terms or limits; the server's privacy note says it keeps the IP address, client id and signaling data in memory until 60 s after the client leaves, and says nothing about logs.
- **Works in the offscreen document:** two throwaway Chromiums registered ids on the local server and connected in 15 ms (host IPv6 pair, DTLS 1.3), with `config.iceServers` set to `[]`.
- **Defaults Kiwi must not keep:** without a `config`, PeerJS uses Google's STUN and PeerJS's own TURN servers (`eu-0`/`us-0.turn.peerjs.com`, shared public credentials), so traffic could be relayed through PeerJS.
- **What the server receives with the PeerJS client:** the full offer and answer (with both DTLS fingerprints) and every trickled candidate, here 20 host candidates, that is all the devices' local IPv4 and IPv6 addresses, in clear. PeerJS has no peer authentication: a server that rewrote the fingerprints could sit in the middle, which the signed handshake above would still catch.
- **Ids:** a taken id is refused (`unavailable-id`), so devices can claim deterministic slots; connecting to an absent id fails with `peer-unavailable`.
- **The server as a mailbox:** PeerServer forwards `OFFER`/`ANSWER`/`CANDIDATE` payloads without reading them and stamps `src` itself (a forged `src` was replaced). With a raw WebSocket client, an opaque 105-byte blob (the size of a reconnect code) arrived intact; a message to an id that connected 1.5 s later was delivered, one to an id that stayed away came back as `EXPIRE` after the default 5 s. So it is no store for offline devices, and a waiting device has to keep a WebSocket open (heartbeat every 5 s), which tells the server when it is online.

If PeerJS is chosen, the safer shape is to use only the server, as a mailbox for the encrypted codes of this design, with a small client of its WebSocket protocol instead of the PeerJS library: the server then sees ids, public IP addresses and timing, not local addresses or fingerprints, and no default TURN can slip in. Ids would be derived from the group key, the device and the day, so they do not stay the same for long; the server address would be a setting (a self-hosted PeerServer runs from its Docker image), and the codes stay as the fallback when the server is unreachable.

## NAT traversal and STUN

- **No STUN:** only host candidates. Enough on one LAN, and across networks when both have public IPv6 addresses whose firewalls allow the outgoing-then-incoming UDP of hole punching. Two devices behind IPv4 NATs on different networks cannot connect.
- **With STUN (default):** each side also learns its public address and port (server-reflexive candidate), and simultaneous checks punch through most home NATs. It still fails when either side's NAT maps each destination to a different port (symmetric NAT, common on mobile carriers' CGNAT and some company networks); see [When a direct connection fails](#when-a-direct-connection-fails). How often that happens is poorly documented: the one published measurement found, in 2015–2016 conference data, that 22% of calls needed a TURN relay ([callstats.io via webrtcHacks](https://webrtchacks.com/usage-stats/)); nothing newer from a primary source was found. Sync between one person's own devices is often on one LAN or at home, so the real share for Kiwi is unknown until phase 1 is tried.
- **What a STUN server learns:** the public IP address and port of the device (RFC 8489: it echoes them back), and when it connects. It sees none of the data and no SDP. The setting is a list of `stun:` URLs typed by the user; a self-hosted one (for example coturn) works the same. If suggestions are shown: Cloudflare documents `stun.cloudflare.com:3478` as free and unlimited ([FAQ](https://developers.cloudflare.com/realtime/turn/faq/)); `stun.l.google.com:19302` is the one most libraries default to, but no Google documentation or terms for it were found.
- **What can block even a LAN connection:** a privacy extension or policy that limits WebRTC to the public interface or to proxied traffic (`webRTCIPHandlingPolicy`: `default_public_interface_only` and `disable_non_proxied_udp` drop private host candidates, RFC 8828), networks that do not pass mDNS when the candidates are mDNS names (Firefox's background page used them; Chrome has hidden page addresses this way since M76 for sites without camera or microphone permission, and Google measured 2 to 7% fewer connections from it), client isolation on guest Wi-Fi, VPNs, and on macOS 15 and later the system's Local Network permission for the browser. The panel explains these when no candidate or no pair appears instead of failing silently.
- **Addresses stay inside the encryption.** Chromium's extension context puts real local IPv4 and IPv6 addresses in the candidates (checked above), and an IPv6 address can be globally unique. Candidates travel only inside encrypted relay frames or encrypted codes, so neither the relay nor whoever carries a code sees them (checked above for the relay). A STUN server, if set, sees the public address.

### When a direct connection fails

Proposed on 2026-11-19, not decided. The relay holds nothing, so both devices are online whenever they try; the only question is how they reach each other. In this order:

1. **Try the direct path properly first.** Wait up to about 10 s for ICE. If STUN is off and the devices are on different networks (each tells the other its candidates' networks inside the encrypted messages), the panel offers to turn STUN on and retries once. After a network change, one ICE restart. This costs nothing and covers the commonest failure, two networks without STUN.
2. **Then relay the encrypted records through the same relay (recommended).** The devices already share a topic and an open WebSocket, so the sync layer sends its records there instead of over the data channel: the same records, encrypted with the record key and signed, inside frames encrypted with the signal key and padded to a few fixed sizes (up to the relay's 16 KiB). Nothing new to deploy and no secret to hold; nothing is stored, because the relay forwards only while both are connected; end-to-end encryption is unchanged. It works through any NAT and on networks that block UDP, since it is a `wss` connection on port 443. The costs: the relay sees how much is synced and when, beyond the signaling it sees anyway; and incoming frames count against the Durable Object quota at 20 to 1, which for kilobytes of settings is negligible (a first full sync of about 50 KB is four frames). The relay's 100 frames per 10 s per socket allow about 160 KiB/s. The panel shows "through the relay, still end-to-end encrypted" so the user knows.
3. **TURN, optional and later.** A TURN server keeps WebRTC's own DTLS end to end through symmetric NATs: the user's own (coturn), or Cloudflare's ($0.05 per GB after 1,000 GB a month free, credentials minted by a Worker from a secret key, UDP, TCP and TLS on port 443, not on Cloudflare's China network; [docs](https://developers.cloudflare.com/realtime/turn/)). Worth it only if large data ever syncs; for settings, option 2 is simpler and needs no secret or per-gigabyte billing.
4. **When the relay cannot be reached either** (mainland China without a custom domain, a network that blocks it): connection codes, and the panel suggests putting both devices on the same network, where host candidates connect without anything else.

## Keys, identity and encryption

### Keys

| Key | Kind | Where | Purpose |
|---|---|---|---|
| Device identity | Ed25519, non-extractable | IndexedDB of the extension | Signs the handshake transcript and every change record; its public key is the device's identity in the member list. |
| Device agreement key | X25519, non-extractable | IndexedDB | Lets a member wrap a new group key for this device when another member is removed. |
| DTLS certificate | ECDSA P-256 `RTCCertificate` | IndexedDB | Transport only. Capped at 365 days by both browsers, so it is replaced 30 days before it expires and the new fingerprint is announced over an authenticated channel. Identity never depends on it alone. |
| Group secret, per epoch | The 256 bits behind the recovery phrase, imported as a non-extractable HKDF key | IndexedDB (the words themselves are not kept) | Root of the group. HKDF-SHA-256 derives the topic key, the signal key (relay frames and codes), the record key (change records) and the member key, each with its own `info` label. |

Everything is WebCrypto; no crypto library is added. Ed25519 and X25519 set the minimum browsers for sync: Chrome and Edge 137 (Ed25519; X25519 came in 133), Firefox 130 (X25519; Ed25519 came in 129), per MDN's compatibility data. Older browsers show the panel as unavailable rather than falling back to weaker primitives.

There is no account and no password; see [Recovery phrase](#recovery-phrase). The 2026-11-15 plan took Brave's seed and mnemonic, and the owner's choice of a 24-word phrase on 2026-11-19 keeps that. In pure P2P the phrase would mostly have been a recovery aid, since there is no server copy to recover; with a relay it is also how a device finds and joins the group.

### Handshake in the channel

After the data channel opens, each side sends `hello`: protocol version, device id, Ed25519 and X25519 public keys, and the SHA-256 of its own and the peer's DTLS certificate as it sees them (`getRemoteCertificates`). The transcript is the ordered pair of hellos.

- **First meeting of two devices:** each side sends `HMAC(member key, transcript)`, proving it holds the phrase. A device in the middle would hold its own DTLS certificates, so the transcripts on its two legs differ and the MACs fail on both, even before the relay's encryption is considered. Then each adds the other's Ed25519 and X25519 public keys to the member list, as a signed record that spreads to the other members.
- **Reconnection:** each side signs the transcript with its Ed25519 key; the peer checks the signature against the member list. This binds the DTLS session to a member, so certificate rotation needs no pin update.

DTLS 1.3 already encrypts and authenticates the channel end to end; the handshake decides **who** is at the other end. Change records are additionally encrypted with the record key and signed, so they stay protected wherever they are relayed or stored (another member forwarding them, the relay if records are ever sent through it, an export file), and a member removed later cannot forge records in the name of others.

### Removing a device

With a phrase, removing a device means a new phrase. A remaining member creates new entropy (a new epoch), wraps it for each remaining member's X25519 key, and signs a removal record holding the removed device's id and the highest sequence number of its records that is still accepted. The wrapped keys travel through the relay or the channel and can be forwarded by any member. Members switch to the new epoch's topics and keys when they receive it, and the user writes down the new phrase; the old one no longer joins anything. Until a member has switched, it still accepts the other members' records under either epoch, and the removed device's records only up to that sequence number, whatever clock they claim.

The removed device keeps everything it already had, and can still derive the old epoch's topics, not the new ones. Removal spreads as members meet: a member that has not heard of it can still sync with the removed device, but a peer already known as removed is rejected on both current and previous topics. Other active devices that missed a rotation can rendezvous on a retained previous topic for up to 30 days; after that they must join with the current phrase. If the removed device is the only one with some change, that change is lost to the others; the panel says so. The same rotation, without removing anyone, replaces a phrase whose paper is lost or that may have been seen.

### Threat model

| Who | What they get | Why |
|---|---|---|
| Someone on the network path, passive or active | Nothing of the data; that two addresses exchanged UDP | DTLS 1.3 with pinned or confirmed fingerprints, signed handshake, encrypted records |
| The relay, its operator and its host (Cloudflare) | Topic ids of the day, IP addresses, timing, the number of devices and of frames | Frames encrypted with the signal key and padded to one size, topic ids rotate daily, nothing stored (checked locally above) |
| Whoever carries a connection code (a chat service, email) | Nothing | Every code is encrypted with the signal key |
| Whoever learns the recovery phrase | Everything synced, and the ability to join | By design; shown once, with plain instructions to keep it; rotating the phrase locks out later changes |
| The configured STUN server when enabled | The public address and timing | Enabled by default; can be disabled |
| A web page, the Kiwi website, an MCP client, another extension | No access | Sync messages are accepted only from Kiwi's own extension pages |
| A lost or removed device | What it already had, and what members that have not yet heard of the removal still give it | Removal rotates the phrase and caps the removed device's records; protection covers only changes made after the members learn of it |
| Malware with access to the browser profile | Everything, as today | Out of scope: it can already read `config` and its API keys |

## Sync model

### Registers

Every synced path is a last-writer-wins register stamped with a hybrid logical clock: 48-bit milliseconds, a 16-bit counter, then the device id to break ties. Writes come from where they already happen: each accepted `kiwi:update-settings` patch (leaf paths from `configUpdates.ts`), the domain block/boost actions, and the preference store. Loading defaults, merging, and `MIGRATIONS` never create records, so a default or a migration on one device cannot overwrite another device's explicit choice.

- Membership fields are per-element registers, so adding `a.com` on one device and `b.com` on another keeps both, as the options page already does locally.
- A deletion is a register set to "deleted" (a tombstone), kept until every current member has seen it.
- Remote clocks more than 24 h ahead of the local wall clock are refused, so one device with a wrong clock cannot win every future conflict.

Why not a CRDT library: the data is a few hundred small fields, the merge rules are per field and Kiwi-specific (categories, the block/boost exclusivity, version skew), and the libraries are large for that. Yjs is about 28 KB gzipped; Automerge's WebAssembly is about 1.1 MB gzipped and would need `'wasm-unsafe-eval'` in the extension's content security policy. Registers with a clock and version vectors are a few hundred lines that the unit tests can cover completely.

### Exchange

Each device appends its own changes as records `(device, seq, hlc, path, value)`, encrypted and signed, and keeps a version vector of the highest contiguous `seq` prefix it holds from each device. On connect, both send their vectors, then the records the other is missing, then acknowledge. Catch-up batches include the sender's `coveredVector`; receivers adopt it after processing the batch so compaction gaps do not stall convergence. When a joining device cannot decrypt older-epoch history, the sender uses signed, current-epoch snapshot records of the current registers instead. A device stranded by a phrase rotation instead meets an authenticated relay-only session on a retained previous topic and receives only missing rotation/removal records plus prerequisites; it then joins the current topic for ordinary catch-up. Records from a third member pass through, so changes reach every member eventually even if some pairs never meet. Superseded records are compacted to the latest per path once all current members have acknowledged them.

### Joining with existing settings

A device that joins already has settings. The panel asks once: **use the group's settings** (the new device's differing values are replaced), **use this device's** (they become new records) or **merge** (membership fields are united; for other fields the group's value wins). The default is the group's settings.

### Versions

Records carry the sender's `CONFIG_VERSION`. A device that does not know a path keeps the record (so it can forward it and use it after an update) but does not apply it. When a migration in `config.ts` renames or rewrites a synced path, it gets a matching record migration in `packages/sync`, so records from older devices land in the right place; [config-and-storage.md](config-and-storage.md) will say so next to `MIGRATIONS`. Every value is checked against the schema and clamped like a local edit before it is written; text from another device is data, never instructions.

## Implementation map

- `packages/sync` (new, pure): recovery phrase (BIP39 encoding and checksum), epoch-independent key derivation, daily HMAC frame and connection-code hints, topic ids, frame sealing and replay checks, code encoding, handshake, HLC, registers, contiguous-prefix version vectors, signed snapshot records, and record migrations. Unit tests in Node with WebCrypto, including out-of-order delivery, compacted-gap coverage, and snapshot bootstrap across an epoch rotation.
- `packages/protocol`: the messages between pages, service worker and offscreen document.
- `apps/relay` (built 2026-11-19): the Worker and its Durable Object, tested in a local `workerd`, with its `wrangler.jsonc`. It stays payload-agnostic and imports nothing from the other packages.
- `apps/extension`: `lib/syncService.ts` (state, apply through the serialized settings writer), `entrypoints/sync-offscreen/` (unlisted page, Chrome and Edge only), `offscreen` added to the Chrome and Edge manifest (no install warning, see above), the Firefox background holding the connection, and the sync panel in `entrypoints/options/` (create or enter the phrase, relay address, STUN, categories, devices, codes as fallback). Transport starts even without a relay so manual codes remain available. The offscreen core survives service-worker port disconnects, reconnects with backoff and a bounded event buffer, reports a state/peer snapshot on reconnect, and leaves an identical `start` untouched. Current and retained legacy relay topics roll at UTC midnight with 0–30 seconds of jitter; sessions are keyed by peer and epoch, legacy sessions carry only bounded rotation/removal catch-up, and relay peers receive 30-second hello keepalives and expire after 90 seconds without inbound frames. All text through the catalogs and `t()`.
- Storage: one IndexedDB database `kiwi-sync` (keys, certificate, records, vectors); `storage.local` keeps only `sync:enabled`, the relay address, the STUN list and the chosen categories. Activation backups in [testing.md](testing.md) must include IndexedDB whenever sync has been activated.

## Plan

| Phase | What | Done when |
|---|---|---|
| 0 (2026-11-19, done) | Feasibility in throwaway browsers: WebRTC in the offscreen document, codes without any server, the encrypted relay in local `workerd`; `apps/relay` built and tested | Recorded above |
| 1 | Two real computers: load the probe in a spare browser profile on each, and connect on one LAN, then with one computer on a phone hotspot, without and with STUN; Edge and a headed Firefox; the relay reached from mainland China. The project relay is deployed and its production transport checks passed 2026-11-20. | A table of what connected, with which candidate pair, and what failed |
| 2 | Prototype: the recovery phrase (create, show once, join), relay signaling with the code fallback, the session inside the options page, sync of the Sources, Search settings, Site preferences, Block lists and Interface categories; `packages/sync` with tests | Two desktop browsers converge after concurrent edits on both; activated in the user's Chromium with storage (and the new IndexedDB) compared before and after |
| 3 | The connection in the background: offscreen document (Chrome, Edge), background page (Firefox); live push while connected; ICE restart over the channel; the midnight overlap of topics; the fallback chosen for [failed direct connections](#when-a-direct-connection-fails) | Edits on one device appear on the other within seconds while both run |
| 4 | Keys and endpoints category with its confirmation; device removal and phrase rotation; encrypted export and import file | Removed device's later records rejected in tests; export restores a device that never met the others |
| 5 (needs its own decision) | TURN; QR codes if a camera or phone client appears | |

## Prior art

- Manual signaling: [cjb/serverless-webrtc](https://github.com/cjb/serverless-webrtc) (offer and answer pasted by hand), [serverless-webrtc-qrcode](https://github.com/fta2012/serverless-webrtc-qrcode) (the same as QR codes), and the QWBP draft above (compact QR payload, rebuilt SDP, derived credentials).
- Identity as a certificate hash: [Syncthing](https://docs.syncthing.net/dev/device-ids.html) (device id = SHA-256 of its certificate, pinned over mutual TLS; it also runs discovery servers and relays, which Kiwi does not).
- Short-code pairing: [Magic Wormhole](https://magic-wormhole.readthedocs.io/en/latest/welcome.html) (SPAKE2 over short codes, through a mailbox server, with a transit relay in TURN's role). A PAKE would let a short code stand in for the phrase when adding a device, but WebCrypto has no PAKE.
- Pairing UX: [PairDrop](https://github.com/schlagmichdoch/PairDrop) (6-digit code or QR, but a signaling server and TURN for remote transfers).
- Brave Sync: the identity and encryption layer this design started from (random seed, 24 words, everything encrypted on the device); see STATUS.md. Unlike Kiwi's relay, Brave's server stores the encrypted data, so devices need not be online together.

## Decisions and open questions

**Default relay decision 1 resolved on 2026-11-20:** the project runs the default relay on its Cloudflare account at `relay.kiwi.moe`. The custom domain is used because `workers.dev` is blocked in mainland China. Users can change the address or leave it empty for manual codes; mainland-China reachability remains unverified.

1. **When a direct connection fails:** the [proposal](#when-a-direct-connection-fails) is to retry with STUN and then relay the encrypted records through the relay, with TURN left for later.
2. **Whether the phrase can be shown again** (then the words must be stored on every device) or only once.
3. Whether a STUN suggestion list is shown, and which servers it names.
4. Whether the Keys and endpoints category exists in the first release.
5. How long the offscreen document stays open when idle (phase 3).

Decided on 2026-11-19: the relay stores nothing, and devices sync only while both are online.

## Implementation status (2026-11-20)

- **Implemented:**
  - `packages/sync`: 24-word BIP39 recovery phrase generation/validation (256-bit entropy + checksum), epoch-independent HKDF key derivation (topic/signal/record/member keys), daily HMAC-derived 4-byte frame and connection-code hints, Ed25519 device signing + X25519 key agreement, AES-256-GCM relay frame and record sealing/opening, 5-minute / 4,096-entry replay guard, `kiwi1-` manual connection-code encoding/decoding with the current epoch, peer handshake, HLC (48-bit ms + 16-bit counter + deterministic device ID tie-breaker) with 24-hour future-clock rejection, per-path LWW registers, per-element set merge with tombstones, contiguous-prefix version vectors and covered catch-up batches, signed current-epoch register snapshots carrying validated active and removed member keys, encoded-size snapshot chunking with oversized-register reporting, indirect third-device propagation, category filtering (`search`, `filters`, `ui`, `keys` with `keys` default-off), join conflict modes (`group`, `local`, `merge`), and member removal with epoch/phrase rotation + X25519-wrapped epoch secrets.
  - Each member signs an epoch-independent certificate over the canonical JSON tuple `["kiwi-sync/v1/member-cert", deviceId, signingPublic, agreementPublic]`. A member's own verified `member-join` attests its agreement key even when a legacy join has no certificate; a valid optional certificate is retained and can propagate through snapshots. Each member stores the sequence of the join that set its agreement key, so an out-of-order older join or snapshot cannot restore an obsolete key. Snapshot members require a valid certificate to become attested, allowing rotated-phrase joiners to trust snapshot-only peers. Snapshots cannot substitute a different agreement key for an already-attested member. A restored current-epoch join is reused only when its certificate is valid; otherwise the device emits a fresh certified join at its next authentication. Persisted members without the attestation field retain the legacy-attested default.
  - `packages/protocol/src/sync.ts`: runtime message and status snapshot types shared between the options page and background worker.
  - `apps/extension`: IndexedDB persistence (`kiwi-sync`, never storing plaintext recovery phrases), separate provisional/established epoch state, deferred remote setting application until initial join conflict resolution, settings-to-sync mapping (`lib/syncMapping.ts`) using the serialized settings writer with echo suppression, `SyncService` (`lib/syncService.ts`) with one mutation queue, Chromium/Edge offscreen WebRTC + relay transport (`entrypoints/sync-offscreen/`, `lib/syncTransportBridge.ts`, `lib/syncTransportCore.ts`) with reconnect snapshots, UTC-midnight topic rollover, persistent relay fallback peers, and offer-scoped queued ICE candidates, Firefox background direct transport fallback, and the options page Sync panel (`entrypoints/options/SyncSection.tsx`) with localized copy in `packages/app/src/i18n/catalog/options.ts`.
  - `apps/relay`: Cloudflare Worker + Durable Object blind relay (unchanged blind-forwarding boundary).
- **Earlier local verification (2026-11-20, before this implementation update):**
  - Workspace `pnpm typecheck`, all package test suites (`@kiwi-search/core` 632, `@kiwi-search/protocol` 35, `@kiwi-search/sync` 14, `@kiwi-search/app` 164, `@kiwi-search/extension` 194, `@kiwi-search/web` 55, `@kiwi-search/mcp` 18, `@kiwi-search/relay` 13; 1,125 tests total), `pnpm build`, Chrome MV3 & Firefox MV2 extension builds, and `apps/web` dist check.
  - Multi-device `SyncService` integration tests and real-extension multi-device E2E in three isolated Chrome profiles against local Wrangler `workerd` relay; details and limitations from that run are retained below.
  - Three-device mesh probe (`relay-mesh-check.mjs`) on local `workerd` with three Chromium 158 instances (5 consecutive runs).
- **Verified for this implementation update (2026-11-20):**
  - `pnpm typecheck`; `pnpm --filter @kiwi-search/sync test` (17 passed); `pnpm --filter @kiwi-search/extension test` (203 passed); `pnpm --filter @kiwi-search/protocol test` (35 passed); `pnpm --filter @kiwi-search/extension build`; and `pnpm --filter @kiwi-search/extension build:firefox`.
  - Production relay at `https://relay.kiwi.moe`: `GET /v1/health` returned 200; WebSocket upgrade with `Origin: https://kiwi.moe` returned 403 and with a `chrome-extension://` origin returned 101; a 1 KiB binary frame from socket A reached socket B unchanged, was not echoed to A, and a later-joining socket received nothing.
- **Verified after the review findings update (2026-11-20):**
  - `pnpm typecheck`; `pnpm --filter @kiwi-search/sync test` (20 passed); `pnpm --filter @kiwi-search/extension test` (214 passed); and `pnpm --filter @kiwi-search/extension build`.
  - Regression coverage includes epoch promotion after provisional members exchange records, preservation of local join preferences before covered catch-up, validated snapshot membership and removals, encoded-size snapshot skipping, retained relay fallback sessions, and queued ICE candidates.
- **Verified after relay recovery, engine serialization, and agreement-key attestation follow-up (2026-11-20):**
  - `pnpm typecheck`; `pnpm --filter @kiwi-search/sync test` (23 passed); `pnpm --filter @kiwi-search/extension test` (216 passed); and `pnpm --filter @kiwi-search/extension build`.
  - Regression coverage includes relay reconnect catch-up and channel-change vector exchange, concurrent sequence allocation, and rejecting snapshot agreement-key substitutions until a member's own signed join.
- **Verified after self-signed member-certificate follow-up (2026-11-20):**
  - `pnpm typecheck`; `pnpm --filter @kiwi-search/sync test` (26 passed); `pnpm --filter @kiwi-search/extension test` (216 passed); and `pnpm --filter @kiwi-search/extension build`.
  - Regression coverage includes certificate identity/key binding, rotated-phrase bootstrap of a snapshot-only active member, and exclusion of forged or missing-certificate substitutions from epoch rotations.
- **Verified after legacy-join restoration follow-up (2026-11-20):**
  - `pnpm typecheck`; `pnpm --filter @kiwi-search/sync test` (27 passed); `pnpm --filter @kiwi-search/extension test` (217 passed); and `pnpm --filter @kiwi-search/extension build`.
  - Regression coverage includes ordinary-record catch-up from legacy joins without certificates, rotation unwrap by restored members, and regeneration of a certified own join after restoring a legacy cached join.
- **Verified after offline phrase-rotation rendezvous follow-up (2026-11-20):**
  - `pnpm typecheck`; `pnpm --filter @kiwi-search/sync test` (27 passed); `pnpm --filter @kiwi-search/extension test` (226 passed); `pnpm --filter @kiwi-search/extension build`; `pnpm --filter @kiwi-search/extension build:firefox`; and `git diff --check`.
  - Regression coverage includes relay-only old-epoch sessions, bounded rotate-record catch-up for a returning device, removed-member rejection, 30-day beacon expiry, UTC-midnight rollover, reconnect announcement, and 90-second relay-peer expiry with bounded keepalives.
- **Verified after legacy-session membership and agreement-sequence follow-up (2026-11-20):**
  - `pnpm typecheck`; `pnpm --filter @kiwi-search/sync test` (29 passed); `pnpm --filter @kiwi-search/extension test` (228 passed); `pnpm --filter @kiwi-search/extension build`; and `git diff --check`.
  - Regression coverage includes rejecting fresh identities from retained topics, recovery by a known attested member, out-of-order join/snapshot sequence handling, and propagating a valid same-key certificate through snapshots to future epoch wraps.
- **Verified after relay rediscovery and SearXNG settings changes (2026-11-23):**
  - With two disposable Chrome profiles on one Mac using `wss://relay.kiwi.moe`, the original build reproduced asymmetric presence after restoring the relay address for the peer that does not initiate WebRTC. The retained relay slot answered with a plain discovery hello but skipped initiating WebRTC; the returning peer received it and waited for an offer that never came. Restoring the address on the other peer instead let the initiator send an offer and recovered both peers. Discovery replies now advertise a retained relay fallback so returning peers can start a fresh authenticated session on relay.
  - On the new build, a fresh pair automatically received the preconfigured SearXNG address and enabled flag. After a relay-address restore, both peers showed online and exchanged pending changes; the newer model name replaced the older offline edit without pressing Sync now or restarting Chrome. A SearXNG-only search on the receiving profile returned 10 results using `https://search.androw.eu/` before enabling key sync. A synthetic SearXNG key was not applied on the second peer by default and synced after enabling keys on both peers.
  - Automated checks also cover rediscovery of a cached relay peer and retrying an unfinished handshake after a direct channel fails. A SearXNG address previously excluded from an existing group's record log is not backfilled on upgrade; editing the address publishes it under Search settings.
  - Not checked in the user's existing Chromium profile, on two physical devices, or in Firefox/Edge.
- **Not verified:**
  - This implementation update was not activated in the user's existing Chromium profile. The managed browser target was unavailable and the running Chrome processes used only disposable `/tmp/kiwi-sync-e2e` profiles; those profiles were left untouched.
  - This membership-hardening follow-up was not activated in a browser or exercised against the production relay; production E2E compatibility was not re-run, and CI was not monitored after pushing, as requested.
  - Reachability from mainland China; two different physical computers or different networks (NAT / STUN / TURN);
  - More than three devices online simultaneously;
  - Full product sync in Firefox or Edge runtime;
  - Concurrent/offline conflict resolution in visible browsers, full manual offer/answer code pairing round-trip, forced relay-only fallback without WebRTC, remote arrival while an Options page has unsaved dirty edits, and long-duration service-worker idle/restart cycles.
- **Security boundary on device removal:** a removed device keeps whatever data and old-epoch keys it already received before removal; members that have not yet learned of the removal may continue syncing with it until they meet a member carrying the new epoch. Rejoining requires the new recovery phrase.

## Connection preferences before setup (2026-11-21)

Advanced settings exposes the relay and STUN editor before and after enrollment. While unenrolled the service saves these fields in local storage under `syncConnection`. Creation and joining inherit them when the corresponding message fields are absent. An empty URL selects manual pairing. Active groups continue using their existing local sync settings. Leaving a group retains its connection preferences for the next setup. Renaming sends only the device name.

Service tests exercise worker restart before enrollment, creating and joining with a custom or empty URL, and renaming without changing the endpoint. The original Chromium profile was used to open the join form and the advanced editor. A second physical device was not enrolled.
