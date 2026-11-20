// The Firefox side of the device-sync feasibility check: the probe in `ext-webrtc/` as a Manifest V2 background page, installed into a
// throwaway headless Firefox through WebDriver BiDi (no web-ext needed). Fresh profile; every http(s) request outside localhost goes to a
// dead proxy. Results go to results-firefox-webrtc.json. See docs/internals/device-sync.md.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sleep, startServers } from './lib.mjs';

const FIREFOX = process.env.FIREFOX ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const S = await startServers();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-ffrtc-ext-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-ffrtc-profile-'));
for (const f of ['shared.js', 'offscreen.js', 'ff-selftest.js']) fs.copyFileSync(path.join(ROOT, 'ext-webrtc', f), path.join(dir, f));
fs.writeFileSync(path.join(dir, 'ff-selftest.js'), fs.readFileSync(path.join(dir, 'ff-selftest.js'), 'utf8').replace('__REPORT__', `http://127.0.0.1:${S.httpPort}/report`));
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
  manifest_version: 2, name: 'Kiwi WebRTC probe', version: '0.0.1',
  background: { scripts: ['shared.js', 'offscreen.js', 'ff-selftest.js'] },
  permissions: ['http://127.0.0.1/*'],
  browser_specific_settings: { gecko: { id: 'webrtc-probe@kiwi.test' } },
}));
const variant = process.argv[2] ?? '';
// The dead proxy keeps the browser's own requests off the network. `noproxy` drops it, to see whether it is what stops ICE.
const deadProxy = { 'network.proxy.type': 1, 'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': 1, 'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': 1,
  'network.proxy.no_proxies_on': 'localhost, 127.0.0.1', 'network.proxy.allow_hijacking_localhost': false };
const prefs = {
  ...(variant === 'noproxy' ? { 'network.proxy.type': 0 } : deadProxy),
  'network.captive-portal-service.enabled': false, 'network.connectivity-service.enabled': false, 'app.update.disabledForTesting': true,
  'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.enabled': false, 'browser.safebrowsing.update.enabled': false,
  'browser.shell.checkDefaultBrowser': false, 'extensions.update.enabled': false, 'xpinstall.signatures.required': false,
  // `node firefox-webrtc.mjs plain`: compare with host addresses not hidden behind mDNS names.
  ...(variant === 'plain' ? { 'media.peerconnection.ice.obfuscate_host_addresses': false } : {}),
};
fs.writeFileSync(path.join(profile, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));

const port = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(FIREFOX, ['-headless', '-no-remote', '-profile', profile, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stderr.on('data', (d) => (log += d));
const out = {};
try {
  for (let i = 0; i < 100 && !log.includes('WebDriver BiDi listening'); i++) await sleep(150);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('BiDi connection failed')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('session.new', { capabilities: {} });
  out.install = (await send('webExtension.install', { extensionData: { type: 'path', path: dir } })).type;
  out.report = await S.waitReport((r) => r.label === 'ff-webrtc', 40000).catch((e) => ({ error: String(e) }));
  // The same two-connection test in an ordinary page, to tell an extension limit from this browser's environment.
  const tree = await send('browsingContext.getTree', {});
  const context = tree.result.contexts[0].context;
  await send('browsingContext.navigate', { context, url: `http://127.0.0.1:${S.httpPort}/page`, wait: 'complete' });
  const page = await send('script.evaluate', { target: { context }, awaitPromise: true, expression: `(async () => {
    const make = () => { const pc = new RTCPeerConnection(); return { pc, dc: pc.createDataChannel('x', { negotiated: true, id: 0 }) }; };
    const a = make(); const b = make();
    a.pc.onicecandidate = (e) => e.candidate && b.pc.addIceCandidate(e.candidate);
    b.pc.onicecandidate = (e) => e.candidate && a.pc.addIceCandidate(e.candidate);
    await a.pc.setLocalDescription(); await b.pc.setRemoteDescription(a.pc.localDescription);
    await b.pc.setLocalDescription(); await a.pc.setRemoteDescription(b.pc.localDescription);
    const opened = await Promise.race([new Promise((r) => { a.dc.onopen = () => r(true); }), new Promise((r) => setTimeout(() => r(false), 10000))]);
    return JSON.stringify({ opened, ice: a.pc.iceConnectionState });
  })()` });
  out.ordinaryPage = page.result?.result?.value ? JSON.parse(page.result.result.value) : page;
  ws.close();
} finally {
  child.kill('SIGTERM');
  await sleep(1500);
  child.kill('SIGKILL');
  S.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
}
fs.writeFileSync(path.join(ROOT, `results-firefox-webrtc${variant ? '-' + variant : ''}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
