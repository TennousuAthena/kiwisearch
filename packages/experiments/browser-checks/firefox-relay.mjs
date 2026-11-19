// The relay (`apps/relay`, run locally in workerd through `wrangler dev`, never deployed) from a throwaway headless Firefox: does a
// Manifest V2 extension's background page (origin `moz-extension://…`) connect and have a frame forwarded, and is an ordinary web page
// refused? Only WebSockets are used, no ICE, so it does not depend on what stopped Firefox's peer connections here (see
// docs/internals/device-sync.md). Fresh profile; every http(s) request outside localhost goes to a dead proxy. Results go to
// results-firefox-relay.json.
//   node firefox-relay.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sleep, startServers } from './lib.mjs';

const FIREFOX = process.env.FIREFOX ?? '/Applications/Firefox.app/Contents/MacOS/firefox';
const RELAY = path.join(ROOT, '../../../apps/relay');
const relayPort = 31000 + Math.floor(Math.random() * 9000);
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-relay-state-'));
const wrangler = spawn(path.join(RELAY, 'node_modules/.bin/wrangler'), [
  'dev', '--config', path.join(RELAY, 'wrangler.jsonc'), '--local', '--ip', '127.0.0.1', '--port', String(relayPort),
  '--persist-to', state, '--show-interactive-dev-session=false', '--log-level', 'warn',
], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: state, CI: '1' }, detached: true, stdio: 'ignore' });
const stopWrangler = () => { try { process.kill(-wrangler.pid, 'SIGTERM'); } catch { /* gone */ } };
process.on('exit', stopWrangler);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopWrangler(); process.exit(130); });

const S = await startServers();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-ffrelay-ext-'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-ffrelay-profile-'));
const RELAY_WS = `ws://127.0.0.1:${relayPort}`;
fs.writeFileSync(path.join(dir, 'background.js'), `(async () => {
  const out = { ua: navigator.userAgent.match(/Firefox\\/[\\d.]+/)?.[0], originScheme: location.origin.split(':')[0] };
  const topic = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  const open = () => new Promise((resolve) => {
    const ws = new WebSocket(${JSON.stringify(RELAY_WS)} + '/v1/' + topic);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => resolve(ws);
    ws.onerror = () => resolve(null);
    setTimeout(() => resolve(null), 8000);
  });
  try {
    const a = await open();
    const b = await open();
    out.opened = !!(a && b);
    if (a && b) {
      const frame = crypto.getRandomValues(new Uint8Array(1564));
      const got = new Promise((resolve) => { b.onmessage = (ev) => resolve(new Uint8Array(ev.data)); setTimeout(() => resolve(null), 4000); });
      a.send(frame);
      const received = await got;
      out.forwarded = !!received && received.length === frame.length && received.every((v, i) => v === frame[i]);
      out.echoedToSender = await new Promise((resolve) => { a.onmessage = () => resolve(true); setTimeout(() => resolve(false), 800); });
      a.close(); b.close();
    }
  } catch (e) { out.error = String(e); }
  await fetch(${JSON.stringify(`http://127.0.0.1:${S.httpPort}/report`)}, { method: 'POST', body: JSON.stringify({ label: 'ff-relay', ...out }) });
})();
`);
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
  manifest_version: 2, name: 'Kiwi relay probe', version: '0.0.1',
  background: { scripts: ['background.js'] },
  permissions: ['http://127.0.0.1/*'],
  browser_specific_settings: { gecko: { id: 'relay-probe@kiwi.test' } },
}));
const prefs = {
  'network.proxy.type': 1, 'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': 1, 'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': 1,
  'network.proxy.no_proxies_on': 'localhost, 127.0.0.1', 'network.proxy.allow_hijacking_localhost': false,
  'network.captive-portal-service.enabled': false, 'network.connectivity-service.enabled': false, 'app.update.disabledForTesting': true,
  'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.enabled': false, 'browser.safebrowsing.update.enabled': false,
  'browser.shell.checkDefaultBrowser': false, 'extensions.update.enabled': false, 'xpinstall.signatures.required': false,
};
fs.writeFileSync(path.join(profile, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));

const port = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(FIREFOX, ['-headless', '-no-remote', '-profile', profile, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stderr.on('data', (d) => (log += d));
const out = {};
try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${relayPort}/nothing`)).status === 404) break; } catch { /* not yet */ }
    await sleep(250);
  }
  for (let i = 0; i < 100 && !log.includes('WebDriver BiDi listening'); i++) await sleep(150);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('BiDi connection failed')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('session.new', { capabilities: {} });
  out.install = (await send('webExtension.install', { extensionData: { type: 'path', path: dir } })).type;
  out.extensionPage = await S.waitReport((r) => r.label === 'ff-relay', 40000).catch((e) => ({ error: String(e) }));

  // The same relay, the same kind of connection, from an ordinary web page of the same browser.
  const tree = await send('browsingContext.getTree', {});
  const context = tree.result.contexts[0].context;
  await send('browsingContext.navigate', { context, url: `http://127.0.0.1:${S.httpPort}/page`, wait: 'complete' });
  const page = await send('script.evaluate', { target: { context }, awaitPromise: true, expression: `new Promise((resolve) => {
    const ws = new WebSocket(${JSON.stringify(`${RELAY_WS}/v1/AAAAAAAAAAAAAAAAAAAAAA`)});
    ws.onopen = () => { resolve(JSON.stringify({ opened: true })); ws.close(); };
    ws.onclose = (ev) => resolve(JSON.stringify({ opened: false, code: ev.code }));
    setTimeout(() => resolve(JSON.stringify({ timeout: true })), 8000);
  })` });
  out.webPage = page.result?.result?.value ? JSON.parse(page.result.result.value) : page;
  ws.close();
} catch (error) {
  out.error = String(error);
} finally {
  child.kill('SIGTERM');
  await sleep(1500);
  child.kill('SIGKILL');
  stopWrangler();
  S.close();
  await sleep(500);
  for (const d of [dir, profile, state]) fs.rmSync(d, { recursive: true, force: true });
}
fs.writeFileSync(path.join(ROOT, 'results-firefox-relay.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
