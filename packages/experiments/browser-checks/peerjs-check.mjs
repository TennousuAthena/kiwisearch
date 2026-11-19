// Evaluating PeerJS for device sync: a local PeerServer (never the public 0.peerjs.com) and two throwaway headless Chromiums, each
// running PeerJS in the probe extension's offscreen document. Records what the signaling server receives (kinds only, no addresses),
// PeerJS's default ICE servers, and what happens when an id is taken. Needs `npm install --prefix tools peer@1.0.2 peerjs@1.5.5`.
//   node peerjs-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, findExtension, launchChromium, sleep } from './lib.mjs';
import { PeerServer } from './tools/node_modules/peer/dist/module.mjs';

const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-peerjs-ext-'));
fs.cpSync(path.join(ROOT, 'ext-webrtc'), ext, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'tools/node_modules/peerjs/dist/peerjs.min.js'), path.join(ext, 'peerjs.min.js'));

// What the server sees: message types, and for offers whether the payload carries the SDP, its candidates' kinds and the fingerprint.
const seen = [];
const port = 30000 + Math.floor(Math.random() * 10000);
const server = PeerServer({ port, path: '/kiwi', key: 'kiwi', host: '127.0.0.1' });
server.on('message', (_client, message) => {
  const sdp = message.payload?.sdp?.sdp;
  seen.push({
    type: message.type,
    ...(sdp ? {
      sdpBytes: sdp.length,
      candidates: [...sdp.matchAll(/a=candidate:\S+ \d udp \d+ (\S+) \d+ typ (\w+)/gi)].map((m) => `${m[2]}/${m[1].endsWith('.local') ? 'mdns' : m[1].includes(':') ? 'ipv6' : 'ipv4'}`),
      fingerprint: /a=fingerprint:/.test(sdp),
    } : {}),
    ...(message.type === 'CANDIDATE' ? { candidate: /typ (\w+)/.exec(message.payload?.candidate?.candidate ?? '')?.[1] ?? null } : {}),
  });
});
await sleep(500);
const SERVER = { host: '127.0.0.1', port, path: '/kiwi', key: 'kiwi' };

async function evaluate(browser, targetId, expression) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const r = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 400));
    return r.result.value;
  } finally { await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
}
async function start() {
  const b = await launchChromium({ ext, httpsPort: 1, allowHosts: ['*.local'] });
  const sw = await findExtension(b.browser);
  await evaluate(b.browser, sw.targetId, "openOffscreen('peer.html')");
  let page;
  for (let i = 0; i < 40 && !page; i++) { page = (await b.browser.send('Target.getTargets')).targetInfos.find((t) => t.url.endsWith('/peer.html')); if (!page) await sleep(150); }
  return { ...b, run: (e) => evaluate(b.browser, page.targetId, e) };
}

const results = {};
const A = await start();
const B = await start();
try {
  results.defaultIceServers = await A.run('pjProbe.defaults()');
  // Ids derived from a shared secret in the design; here two random hex strings.
  const idA = 'kiwi-' + crypto.randomUUID().replaceAll('-', '');
  const idB = 'kiwi-' + crypto.randomUUID().replaceAll('-', '');
  results.registerA = await A.run(`pjProbe.start(${JSON.stringify(SERVER)}, ${JSON.stringify(idA)}, [])`);
  results.registerB = await B.run(`pjProbe.start(${JSON.stringify(SERVER)}, ${JSON.stringify(idB)}, [])`);
  results.connect = await B.run(`pjProbe.connect(${JSON.stringify(idA)})`);
  await sleep(300);
  results.ping = await B.run('pjProbe.ping()');
  results.statusB = await B.run('pjProbe.status()');
  // A third client asking for an id that is already registered.
  const C = await start();
  results.sameIdAgain = await C.run(`pjProbe.start(${JSON.stringify(SERVER)}, ${JSON.stringify(idA)}, [])`);
  await C.stop();
  // Connecting to an id nobody holds.
  results.connectToAbsent = await B.run(`pjProbe.connect('kiwi-nobody-${Date.now()}')`);
  results.errorsB = (await B.run('pjProbe.status()')).errors;
} catch (error) {
  results.error = String(error);
} finally {
  await A.stop();
  await B.stop();
  fs.rmSync(ext, { recursive: true, force: true });
}
results.serverSaw = seen;
fs.writeFileSync(path.join(ROOT, 'results-peerjs.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
process.exit(0);
