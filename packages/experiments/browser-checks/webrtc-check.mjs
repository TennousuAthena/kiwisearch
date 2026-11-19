// Device-sync feasibility: WebRTC between two throwaway headless Chromiums, each with the probe extension in `ext-webrtc/`.
// No STUN or TURN server and no signaling server: the script carries the compact connection codes between the two browsers,
// standing in for the user copying them. Prints kinds of candidates, never addresses. See docs/internals/device-sync.md.
//   node webrtc-check.mjs [idle-seconds]
//   node webrtc-check.mjs delay [seconds,…]   a person carrying codes is slow: wait that long before each code is used
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, findExtension, launchChromium, sleep } from './lib.mjs';

const EXT = path.join(ROOT, 'ext-webrtc');
const DELAY_MODE = process.argv[2] === 'delay';
const IDLE_SECONDS = DELAY_MODE ? 0 : Number(process.argv[2] ?? 45);
const DELAYS = DELAY_MODE ? (process.argv[3] ?? '15,45,90').split(',').map(Number) : [];

/** Attach, evaluate, detach: staying attached to a service worker would keep it alive and spoil the idle check. */
async function evaluate(browser, targetId, expression) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const r = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 400));
    return r.result.value;
  } finally {
    await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

async function targets(browser) {
  return (await browser.send('Target.getTargets')).targetInfos;
}

async function offscreenTarget(browser) {
  for (let i = 0; i < 40; i++) {
    const t = (await targets(browser)).find((x) => x.url.endsWith('/offscreen.html'));
    if (t) return t;
    await sleep(150);
  }
  throw new Error('offscreen document did not appear');
}

async function start(label) {
  const b = await launchChromium({ ext: EXT, httpsPort: 1, allowHosts: ['*.local'] });
  const sw = await findExtension(b.browser);
  const opened = await evaluate(b.browser, sw.targetId, 'openOffscreen()');
  const off = await offscreenTarget(b.browser);
  const run = (expr) => evaluate(b.browser, off.targetId, expr);
  return { ...b, label, sw, off, opened, run, offType: off.type };
}

const results = { chromium: null, startedAt: new Date().toISOString() };
const A = await start('A');
const B = await start('B');
try {
  results.chromium = (await A.browser.send('Browser.getVersion')).product;
  results.serviceWorker = await evaluate(A.browser, A.sw.targetId, 'swProbe()');
  results.offscreen = { created: A.opened, targetType: A.offType };
  results.offscreenCrypto = await A.run('probe.cryptoProbe()');
  results.munging = await A.run('probe.mungeTest()');

  const certA = await A.run('probe.loadCertificate()');
  const certB = await B.run('probe.loadCertificate()');
  results.certificate = { A: { created: certA.created, expiresInDays: certA.expiresInDays, requestedDays: certA.requestedDays }, B: { created: certB.created } };

  if (DELAY_MODE) {
    const waitOpen = async (P, fingerprint) => {
      for (let i = 0; i < 300; i++) {
        const s = await P.run(`probe.status(${JSON.stringify(fingerprint)})`);
        if (s.channel === 'open' || s.connectionState === 'failed') return s;
        await sleep(100);
      }
      return P.run(`probe.status(${JSON.stringify(fingerprint)})`);
    };
    results.delays = [];
    for (const seconds of DELAYS) {
      // Two codes: B answers at once and starts checking; A applies the reply only `seconds` later.
      await A.run('probe.reset()'); await B.run('probe.reset()');
      const offer = await A.run('probe.makeOffer([])');
      const answer = await B.run(`probe.acceptOffer(${JSON.stringify(offer.code)}, [])`);
      await sleep(seconds * 1000);
      const stateBBefore = (await B.run('probe.status()')).connectionState;
      await A.run(`probe.acceptAnswer(${JSON.stringify(answer.code)})`);
      const twoWay = await waitOpen(A, certB.fingerprint);
      // One code: A has built B's answer already and waits; B uses A's code only `seconds` later.
      await A.run('probe.reset()'); await B.run('probe.reset()');
      const iceChars = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/'[b % 64]).join('');
      const credsA = { u: iceChars(8), p: iceChars(24) };
      const credsB = { u: iceChars(8), p: iceChars(24) };
      const oneWayOffer = await A.run(`probe.oneWayOffer(${JSON.stringify(credsA)})`);
      await A.run(`probe.oneWaySynthesizeAnswer(${JSON.stringify(credsB)}, ${JSON.stringify(certB.fingerprint)})`);
      await sleep(seconds * 1000);
      const stateABefore = (await A.run('probe.status()')).connectionState;
      await B.run(`probe.oneWayAccept(${JSON.stringify(oneWayOffer.code)}, ${JSON.stringify(credsB)})`);
      const oneWayStatus = await waitOpen(A, certB.fingerprint);
      results.delays.push({
        seconds,
        twoCodes: { answererStateWhileWaiting: stateBBefore, channel: twoWay.channel, connectionState: twoWay.connectionState, answerToOpenMs: twoWay.answerToOpenMs ?? null },
        oneCode: { offererStateWhileWaiting: stateABefore, channel: oneWayStatus.channel, connectionState: oneWayStatus.connectionState },
      });
      console.error(JSON.stringify(results.delays.at(-1)));
    }
    throw new Error('delay mode done');
  }

  // The handshake, with only the compact codes crossing between the two browsers.
  const offer = await A.run('probe.makeOffer([])');
  const answer = await B.run(`probe.acceptOffer(${JSON.stringify(offer.code)}, [])`);
  await A.run(`probe.acceptAnswer(${JSON.stringify(answer.code)})`);
  const strip = ({ code, ...rest }) => rest;
  results.offer = { ...strip(offer), fingerprintMatchesCertificate: offer.code.f === certA.fingerprint, ufragLength: offer.code.u.length, pwdLength: offer.code.p.length };
  results.answer = { ...strip(answer), fingerprintMatchesCertificate: answer.code.f === certB.fingerprint };

  let statusA;
  for (let i = 0; i < 100; i++) {
    statusA = await A.run(`probe.status(${JSON.stringify(certB.fingerprint)})`);
    if (statusA.channel === 'open' || statusA.connectionState === 'failed') break;
    await sleep(100);
  }
  results.connectedA = statusA;
  results.connectedB = await B.run(`probe.status(${JSON.stringify(certA.fingerprint)})`);
  if (statusA.channel === 'open') {
    results.pingMs = await A.run('probe.ping()');
    results.bulk = await A.run('probe.bulk(4 * 1024 * 1024, 16 * 1024)');
    await sleep(300);
    results.bulkReceivedBytes = (await B.run('probe.status()')).receivedBytes;

    // Leave everything idle with no debugger on the service workers, then see what is still alive.
    await sleep(IDLE_SECONDS * 1000);
    const swAlive = (await targets(A.browser)).some((t) => t.type === 'service_worker' && t.url.includes(A.sw.id));
    results.afterIdle = { seconds: IDLE_SECONDS, serviceWorkerListedA: swAlive, offscreenListedA: (await targets(A.browser)).some((t) => t.url.endsWith('/offscreen.html')), pingMs: await A.run('probe.ping()'), channelA: (await A.run('probe.status()')).channel };
  }

  // One-way reconnection: only A's code crosses; A builds B's answer from credentials both know and B's pinned fingerprint.
  await A.run('probe.reset()');
  await B.run('probe.reset()');
  const iceChars = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/'[b % 64]).join('');
  const credsA = { u: iceChars(8), p: iceChars(24) };
  const credsB = { u: iceChars(8), p: iceChars(24) };
  const oneWay = await A.run(`probe.oneWayOffer(${JSON.stringify(credsA)})`);
  await B.run(`probe.oneWayAccept(${JSON.stringify(oneWay.code)}, ${JSON.stringify(credsB)})`);
  await A.run(`probe.oneWaySynthesizeAnswer(${JSON.stringify(credsB)}, ${JSON.stringify(certB.fingerprint)})`);
  let oneWayStatus;
  for (let i = 0; i < 100; i++) {
    oneWayStatus = await A.run(`probe.status(${JSON.stringify(certB.fingerprint)})`);
    if (oneWayStatus.channel === 'open' || oneWayStatus.connectionState === 'failed') break;
    await sleep(100);
  }
  results.oneWay = { offerCredsUsed: oneWay.code.u === credsA.u, connectionState: oneWayStatus.connectionState, channel: oneWayStatus.channel, selectedPair: oneWayStatus.selectedPair, answerToOpenMs: oneWayStatus.answerToOpenMs, remoteCertificateMatches: oneWayStatus.remoteCertificateMatches, pingMs: oneWayStatus.channel === 'open' ? await A.run('probe.ping()') : null };

  // For comparison: what an ordinary page in the same browser puts in its candidates.
  const { targetId: pageId } = await A.browser.send('Target.createTarget', { url: 'about:blank' });
  results.ordinaryPageCandidates = await evaluate(A.browser, pageId, `(async () => {
    const pc = new RTCPeerConnection(); pc.createDataChannel('x'); await pc.setLocalDescription();
    await new Promise((r) => { if (pc.iceGatheringState === 'complete') r(); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); });
    const kinds = [...pc.localDescription.sdp.matchAll(/a=candidate:\\S+ \\d udp \\d+ (\\S+) \\d+ typ (\\w+)/gi)].map((m) => m[2] + '/' + (m[1].endsWith('.local') ? 'mdns' : m[1].includes(':') ? 'ipv6' : 'ipv4'));
    pc.close(); return kinds; })()`);

  // The certificate survives the offscreen document being closed and opened again.
  results.wakeFromOffscreen = await A.run("chrome.runtime.sendMessage('wake')");
  const sw = await findExtension(A.browser);
  await evaluate(A.browser, sw.targetId, 'closeOffscreen()');
  await sleep(300);
  await evaluate(A.browser, sw.targetId, 'openOffscreen()');
  A.off = await offscreenTarget(A.browser);
  const reopened = await evaluate(A.browser, A.off.targetId, 'probe.loadCertificate()');
  results.certificateAfterReopen = { created: reopened.created, sameFingerprint: reopened.fingerprint === certA.fingerprint };
} catch (error) {
  if (!String(error).includes('delay mode done')) results.error = String(error);
} finally {
  await A.stop();
  await B.stop();
}
const out = path.join(ROOT, DELAY_MODE ? 'results-webrtc-delay.json' : 'results-webrtc.json');
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
