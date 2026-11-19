// Device sync through Kiwi's relay (`apps/relay`, a Cloudflare Worker), checked locally: it runs in Cloudflare's own runtime
// (workerd) through `wrangler dev`, never deployed; two throwaway headless Chromiums run the encrypted signaling of
// `ext-webrtc/relay-probe.js` in their offscreen documents and open a WebRTC data channel. A third client joins the same topic as a
// spy, which sees exactly what the relay sees, then replays and tampers with frames. Needs only `pnpm install` at the repository root.
//   node relay-check.mjs [idle-seconds]   (default 0: after the checks, leave the sockets idle that long, then send through the relay again)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, findExtension, launchChromium, sleep, startServers } from './lib.mjs';

const EXT = path.join(ROOT, 'ext-webrtc');
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-relay-state-'));
const port = 31000 + Math.floor(Math.random() * 9000);
const URL_BASE = `ws://127.0.0.1:${port}`;
const IDLE_SECONDS = Number(process.argv[2] ?? 0);

const RELAY = path.join(ROOT, '../../../apps/relay');
const wrangler = spawn(path.join(RELAY, 'node_modules/.bin/wrangler'), [
  'dev', '--config', path.join(RELAY, 'wrangler.jsonc'), '--local', '--ip', '127.0.0.1', '--port', String(port),
  '--persist-to', state, '--show-interactive-dev-session=false', '--log-level', 'warn',
], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: state, CI: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let wranglerLog = '';
wrangler.stdout.on('data', (d) => (wranglerLog += d));
wrangler.stderr.on('data', (d) => (wranglerLog += d));
const stopWrangler = () => { try { process.kill(-wrangler.pid, 'SIGTERM'); } catch { /* gone */ } };
// wrangler runs detached; stop it however this script ends, so an interrupted run leaves no relay listening.
process.on('exit', stopWrangler);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopWrangler(); process.exit(130); });

async function relayUp() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/nothing`)).status === 404) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error('relay did not start: ' + wranglerLog.slice(-600));
}

async function evaluate(browser, targetId, expression) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const r = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 400));
    return r.result.value;
  } finally { await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
}

async function device() {
  const b = await launchChromium({ ext: EXT, httpsPort: 1, allowHosts: ['*.local'] });
  const sw = await findExtension(b.browser);
  // The worker's target can appear before its script has run.
  for (let i = 0; i < 40 && !(await evaluate(b.browser, sw.targetId, "typeof openOffscreen === 'function'")); i++) await sleep(150);
  await evaluate(b.browser, sw.targetId, "openOffscreen('relay.html')");
  let page;
  for (let i = 0; i < 40 && !page; i++) { page = (await b.browser.send('Target.getTargets')).targetInfos.find((t) => t.url.endsWith('/relay.html')); if (!page) await sleep(150); }
  return { ...b, run: (e) => evaluate(b.browser, page.targetId, e) };
}

function socket(topic) {
  const ws = new WebSocket(`${URL_BASE}/v1/${topic}`);
  ws.binaryType = 'arraybuffer';
  const frames = [];
  const closed = new Promise((resolve) => { ws.onclose = (ev) => resolve(ev.code); });
  ws.onmessage = (ev) => frames.push(ev.data);
  return new Promise((resolve, reject) => { ws.onopen = () => resolve({ ws, frames, closed }); ws.onerror = () => reject(new Error('spy could not connect')); });
}

const results = {};
let A;
let B;
try {
  await relayUp();
  results.runtime = (wranglerLog.match(/wrangler[^\n]*?(\d+\.\d+\.\d+)/i)?.[1]) ?? 'see log';
  A = await device();
  B = await device();
  // The group secret both devices hold (in the design: from the 24-word recovery phrase).
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const joinB = await B.run(`relay.join(${JSON.stringify(URL_BASE)}, ${JSON.stringify(secret)}, 'device-b')`);
  await B.run('relay.listen()');
  const spy = await socket(joinB.topic);
  const joinA = await A.run(`relay.join(${JSON.stringify(URL_BASE)}, ${JSON.stringify(secret)}, 'device-a')`);
  results.sameTopic = joinA.topic === joinB.topic;
  results.topicLength = joinA.topic.length;
  results.call = await A.run('relay.call()');
  results.ping = results.call.channel === 'open' ? await A.run('relay.ping()') : null;
  await sleep(300);

  // What the relay saw.
  const raw = spy.frames.map((f) => Buffer.from(f));
  const text = raw.map((b) => b.toString('latin1')).join('\n');
  results.relaySaw = {
    frames: raw.length,
    sizes: [...new Set(raw.map((b) => b.length))],
    plaintextMarkers: ['candidate', 'ufrag', 'fingerprint', 'offer', 'answer', 'hello', 'device-a', 'device-b', 'typ host', 'sha-256'].filter((m) => text.toLowerCase().includes(m)),
    looksLikeIpv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text),
    looksLikeIpv6: /\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){4,7}\b/i.test(text),
  };

  // Replays and forgeries from the relay's position.
  for (const f of raw) spy.ws.send(f);
  const tampered = Buffer.from(raw[raw.length - 1]);
  tampered[40] ^= 0x01;
  spy.ws.send(tampered);
  const forged = Buffer.concat([Buffer.from(crypto.getRandomValues(new Uint8Array(12))), Buffer.from(crypto.getRandomValues(new Uint8Array(raw[0].length - 12)))]);
  spy.ws.send(forged);
  await sleep(800);
  const statusA = await A.run('relay.status()');
  const statusB = await B.run('relay.status()');
  const count = (list) => list.reduce((acc, r) => ((acc[r] = (acc[r] ?? 0) + 1), acc), {});
  results.afterAttacks = {
    replayedFrames: raw.length,
    rejectedByA: count(statusA.rejected),
    rejectedByB: count(statusB.rejected),
    channelStillOpen: statusA.channel === 'open' && statusB.channel === 'open',
    pingAfter: await A.run('relay.ping()'),
  };

  // The relay's own limits.
  const t = await socket(joinA.topic);
  t.ws.send('a text frame');
  const big = await socket(joinA.topic);
  big.ws.send(new Uint8Array(16_385));
  const within = (promise) => Promise.race([promise, sleep(5000).then(() => 'still open after 5 s')]);
  results.relayLimits = { textFrameClosedWith: await within(t.closed), oversizeFrameClosedWith: await within(big.closed) };
  spy.ws.close();

  // Web pages are refused in a real browser, the Kiwi website's address included: the browser sends the page's Origin and the relay
  // answers 403. The handshake line Chromium logs tells that apart from the browser blocking the page itself (mixed content).
  const web = await startServers();
  const pageBrowser = await launchChromium({ httpsPort: web.httpsPort });
  try {
    results.webPages = {};
    for (const [label, url] of [['https://kiwi.moe', 'https://kiwi.moe/'], ['http://127.0.0.1', `http://127.0.0.1:${web.httpPort}/page`]]) {
      const { targetId } = await pageBrowser.browser.send('Target.createTarget', { url });
      await sleep(800);
      const { sessionId } = await pageBrowser.browser.send('Target.attachToTarget', { targetId, flatten: true });
      const logs = [];
      pageBrowser.browser.on((m) => { if (m.sessionId === sessionId && m.method === 'Log.entryAdded') logs.push(m.params.entry.text); });
      await pageBrowser.browser.send('Log.enable', {}, sessionId);
      const attempt = `new Promise((resolve) => {
        const ws = new WebSocket(${JSON.stringify(`${URL_BASE}/v1/${joinA.topic}`)});
        ws.onopen = () => { resolve({ opened: true }); ws.close(); };
        ws.onclose = (ev) => resolve({ opened: false, code: ev.code });
        setTimeout(() => resolve({ timeout: true }), 8000);
      })`;
      const r = await pageBrowser.browser.send('Runtime.evaluate', { expression: attempt, awaitPromise: true, returnByValue: true }, sessionId);
      await sleep(300);
      const line = logs.find((text) => /WebSocket/.test(text)) ?? '';
      results.webPages[label] = { ...r.result.value, handshake: line.match(/Unexpected response code: \d+|Mixed Content[^.]*/)?.[0] ?? (line.slice(-120) || 'no log line') };
    }
  } finally {
    await pageBrowser.stop();
    web.close();
  }

  if (IDLE_SECONDS) {
    await sleep(IDLE_SECONDS * 1000);
    const before = (await B.run('relay.status()')).log.filter(([, type]) => type === 'idle-check').length;
    await A.run("relay.say('idle-check')");
    await sleep(800);
    const after = (await B.run('relay.status()')).log.filter(([, type]) => type === 'idle-check').length;
    results.afterIdle = { seconds: IDLE_SECONDS, relayForwarded: after === before + 1, channelOpen: (await A.run('relay.status()')).channel === 'open' };
  }
} catch (error) {
  results.error = String(error);
} finally {
  await A?.stop();
  await B?.stop();
  stopWrangler();
  await sleep(800);
  fs.rmSync(state, { recursive: true, force: true });
}
results.wranglerWarnings = wranglerLog.split('\n').filter((l) => /warn|error/i.test(l)).slice(0, 5);
fs.writeFileSync(path.join(ROOT, 'results-relay.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
process.exit(0);
