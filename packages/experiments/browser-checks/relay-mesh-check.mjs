// Three devices in one relay topic at the same time (see docs/internals/device-sync.md): `apps/relay` runs locally in workerd through
// `wrangler dev`, never deployed, and three throwaway headless Chromiums run `ext-webrtc/relay-probe.js` in their offscreen documents.
// A and B connect first; C then joins the same topic. Checked: every pair has its own open data channel, the channel between A and B
// is the same connection as before C joined, bytes sent to one device arrive at that device only, and a device that leaves and comes
// back is reconnected without disturbing the pair that stayed. Needs only `pnpm install` at the repository root.
//   node relay-mesh-check.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, findExtension, launchChromium, sleep } from './lib.mjs';

const EXT = path.join(ROOT, 'ext-webrtc');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-relay-state-'));
const port = 31000 + Math.floor(Math.random() * 9000);
const URL_BASE = `ws://127.0.0.1:${port}`;

const RELAY = path.join(ROOT, '../../../apps/relay');
const wrangler = spawn(path.join(RELAY, 'node_modules/.bin/wrangler'), [
  'dev', '--config', path.join(RELAY, 'wrangler.jsonc'), '--local', '--ip', '127.0.0.1', '--port', String(port),
  '--persist-to', state, '--show-interactive-dev-session=false', '--log-level', 'warn',
], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: state, CI: '1' }, detached: true, stdio: 'ignore' });
const stopWrangler = () => { try { process.kill(-wrangler.pid, 'SIGTERM'); } catch { /* gone */ } };
process.on('exit', stopWrangler);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopWrangler(); process.exit(130); });

async function relayUp() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/nothing`)).status === 404) return; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error('relay did not start');
}

async function evaluate(browser, targetId, expression) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const r = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 400));
    return r.result.value;
  } finally { await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
}

async function device(name, secret) {
  const b = await launchChromium({ ext: EXT, httpsPort: 1, allowHosts: ['*.local'] });
  launched.push(b);
  const sw = await findExtension(b.browser);
  // The worker's target can appear before its script has run.
  for (let i = 0; i < 40 && !(await evaluate(b.browser, sw.targetId, "typeof openOffscreen === 'function'")); i++) await sleep(150);
  await evaluate(b.browser, sw.targetId, "openOffscreen('relay.html')");
  let page;
  for (let i = 0; i < 40 && !page; i++) { page = (await b.browser.send('Target.getTargets')).targetInfos.find((t) => t.url.endsWith('/relay.html')); if (!page) await sleep(150); }
  const run = (e) => evaluate(b.browser, page.targetId, e);
  await run(`relay.join(${JSON.stringify(URL_BASE)}, ${JSON.stringify(secret)}, ${JSON.stringify(name)})`);
  return { ...b, launch: b, name, run };
}

const NAMES = ['device-a', 'device-b', 'device-c'];
/** Each device's view of the others: channel state, certificate check, bytes received, and a ping over that channel. */
async function mesh(devices) {
  const out = {};
  for (const d of devices) {
    const { peers } = await d.run('relay.status()');
    out[d.name] = {};
    for (const other of devices) {
      if (other === d) continue;
      const p = peers[other.name];
      out[d.name][other.name] = p ? { ...p, pingMs: p.channel === 'open' ? await d.run(`relay.ping(${JSON.stringify(other.name)})`) : null } : 'no connection';
    }
  }
  return out;
}
const allOpen = (view) => Object.values(view).every((row) => Object.values(row).every((p) => p.channel === 'open' && p.peerCertificateMatches === true && p.pingMs != null));
/** When the current data channel to `peer` opened, on the device's own clock: unchanged means the connection was not replaced. */
const openedAt = (d, peer) => d.run(`(probe.use(${JSON.stringify(peer)}), probe.status()).then((s) => s.log.find(([, k, v]) => k === 'dc' && v === 'open')?.[0] ?? null)`);

const results = {};
const devices = [];
// Every browser started, so that a failed run leaves none behind.
const launched = [];
try {
  await relayUp();
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const A = await device(NAMES[0], secret);
  devices.push(A);
  const B = await device(NAMES[1], secret);
  devices.push(B);
  results.twoDevices = await B.run('relay.call()');
  const before = await openedAt(A, 'device-b');

  // The third device joins while the first two are connected.
  const C = await device(NAMES[2], secret);
  devices.push(C);
  results.thirdJoins = await C.run('relay.call()');
  await sleep(500);
  results.mesh = await mesh(devices);
  results.everyPairOpen = allOpen(results.mesh);
  results.firstPairKept = before != null && (await openedAt(A, 'device-b')) === before;

  // Bytes for one device arrive at that device only.
  await A.run("relay.bulk('device-c', 65536)");
  await C.run("relay.bulk('device-b', 32768)");
  await sleep(500);
  const after = await mesh(devices);
  results.received = Object.fromEntries(Object.entries(after).map(([name, row]) => [name, Object.fromEntries(Object.entries(row).map(([peer, p]) => [peer, p.receivedBytes]))]));
  results.bytesReachedOnlyTheirDevice = after['device-c']['device-a'].receivedBytes === 65536 && after['device-b']['device-c'].receivedBytes === 32768
    && after['device-b']['device-a'].receivedBytes === 0 && after['device-a']['device-b'].receivedBytes === 0 && after['device-a']['device-c'].receivedBytes === 0 && after['device-c']['device-b'].receivedBytes === 0;

  // The middle device leaves and comes back (it is the offerer towards C and the answerer towards A).
  const keptAC = await openedAt(A, 'device-c');
  await B.stop();
  launched.splice(launched.indexOf(B.launch), 1);
  devices.splice(1, 1);
  await sleep(1500);
  const B2 = await device(NAMES[1], secret);
  devices.splice(1, 0, B2);
  results.secondRejoins = await B2.run('relay.call()');
  await sleep(500);
  results.meshAfterRejoin = await mesh(devices);
  results.everyPairOpenAfterRejoin = allOpen(results.meshAfterRejoin);
  results.otherPairKept = keptAC != null && (await openedAt(A, 'device-c')) === keptAC;

  // All three announce at once: no pair may end up with two offers crossing.
  await Promise.all(devices.map((d) => d.run("relay.say('hello')")));
  await sleep(3000);
  results.meshAfterSimultaneousHello = await mesh(devices);
  results.everyPairOpenAfterSimultaneousHello = allOpen(results.meshAfterSimultaneousHello);
  results.problems = (await Promise.all(devices.map((d) => d.run('relay.status()')))).flatMap((s, i) => s.log.filter(([, type]) => /failed/.test(type)).map((entry) => [devices[i].name, ...entry.slice(1)]));
} catch (error) {
  results.error = String(error);
} finally {
  for (const b of launched) await b.stop().catch(() => {});
  stopWrangler();
  await sleep(800);
  fs.rmSync(state, { recursive: true, force: true });
}
results.pass = !results.error && results.everyPairOpen && results.firstPairKept && results.bytesReachedOnlyTheirDevice && results.everyPairOpenAfterRejoin && results.otherPairKept && results.everyPairOpenAfterSimultaneousHello && results.problems.length === 0;
fs.writeFileSync(path.join(ROOT, 'results-relay-mesh.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
process.exit(results.pass ? 0 : 1);
