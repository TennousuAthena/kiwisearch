// Encrypted signaling through a relay that only forwards opaque frames (apps/relay), for docs/internals/device-sync.md.
// Runs in the offscreen document next to offscreen.js (probe.makeOffer/acceptOffer/acceptAnswer/status).
//
// Keys come from a 32-byte group secret (in the design: the entropy behind the 24-word recovery phrase) through HKDF:
//   topic key  -> the relay topic id, an HMAC of the UTC day, so the id the relay sees changes daily;
//   signal key -> AES-256-GCM over every frame, with the topic id as associated data.
// A frame is nonce (12) || ciphertext of a JSON message padded to a fixed size, so the relay learns neither the content nor its length.
// Messages carry a random id and a time; repeats and old messages are dropped.

const FRAME_PLAINTEXT = 1536;
const MAX_AGE_MS = 120_000;
const rs = { ws: null, keys: null, topic: null, device: null, seen: new Set(), log: [], rejected: [], waiters: [], peerFingerprint: null };

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function deriveKeys(secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const params = (label) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('kiwi-sync/v1/' + label) });
  return {
    topic: await crypto.subtle.deriveKey(params('topic'), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
    signal: await crypto.subtle.deriveKey(params('signal'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  };
}

async function topicFor(keys, day) {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keys.topic, enc.encode('day:' + day)));
  return b64url(mac.slice(0, 16));
}

async function seal(message) {
  const body = enc.encode(JSON.stringify(message));
  if (body.length + 2 > FRAME_PLAINTEXT) throw new Error('message too large for one frame');
  const padded = new Uint8Array(FRAME_PLAINTEXT);
  new DataView(padded.buffer).setUint16(0, body.length);
  padded.set(body, 2);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(rs.topic) }, rs.keys.signal, padded));
  const frame = new Uint8Array(12 + ct.length);
  frame.set(iv);
  frame.set(ct, 12);
  return frame;
}

async function open(frame) {
  const bytes = new Uint8Array(frame);
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(rs.topic) }, rs.keys.signal, bytes.slice(12)));
  } catch { return { rejected: 'decryption failed' }; }
  const length = new DataView(plain.buffer).getUint16(0);
  const message = JSON.parse(dec.decode(plain.slice(2, 2 + length)));
  if (rs.seen.has(message.id)) return { rejected: 'replay' };
  if (Math.abs(Date.now() - message.t) > MAX_AGE_MS) return { rejected: 'too old' };
  rs.seen.add(message.id);
  return { message };
}

function send(type, to, body) {
  const id = b64url(crypto.getRandomValues(new Uint8Array(12)));
  // A device never acts on its own messages, even when someone sends them back to it.
  rs.seen.add(id);
  return seal({ type, from: rs.device, to, body, id, t: Date.now() }).then((frame) => rs.ws.send(frame));
}

function waitFor(predicate, ms = 15000) {
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve };
    rs.waiters.push(waiter);
    setTimeout(() => { rs.waiters.splice(rs.waiters.indexOf(waiter), 1); reject(new Error('timed out waiting for a relay message')); }, ms);
  });
}

async function onFrame(data) {
  if (typeof data === 'string') return rs.rejected.push('text frame');
  const { message, rejected } = await open(data);
  if (rejected) return rs.rejected.push(rejected);
  if (message.to && message.to !== rs.device) return;
  rs.log.push([Math.round(performance.now()), message.type, message.from]);
  // Answer an offer addressed to this device.
  if (message.type === 'offer') {
    rs.peerFingerprint = message.body.f;
    probe.reset();
    const answer = await probe.acceptOffer(message.body, []);
    await send('answer', message.from, answer.code);
  }
  for (const waiter of [...rs.waiters]) {
    if (waiter.predicate(message)) { rs.waiters.splice(rs.waiters.indexOf(waiter), 1); waiter.resolve(message); }
  }
}

self.relay = {
  async join(url, secretB64, device, day = Math.floor(Date.now() / 86400e3)) {
    await probe.loadCertificate();
    rs.keys = await deriveKeys(fromB64url(secretB64));
    rs.topic = await topicFor(rs.keys, day);
    rs.device = device;
    rs.ws = new WebSocket(`${url}/v1/${rs.topic}`);
    rs.ws.binaryType = 'arraybuffer';
    rs.ws.onmessage = (ev) => { void onFrame(ev.data); };
    rs.ws.onclose = (ev) => rs.log.push([Math.round(performance.now()), 'relay closed', ev.code]);
    await new Promise((resolve, reject) => { rs.ws.onopen = resolve; rs.ws.onerror = () => reject(new Error('relay connection failed')); });
    return { topic: rs.topic };
  },

  /** Announce, wait for the other device, offer, apply its answer; returns when the data channel is open or fails. */
  async call() {
    const started = performance.now();
    await send('hello', null, {});
    const hello = await waitFor((m) => m.type === 'hello' || m.type === 'here');
    probe.reset();
    const offer = await probe.makeOffer([]);
    await send('offer', hello.from, offer.code);
    const answer = await waitFor((m) => m.type === 'answer' && m.from === hello.from);
    rs.peerFingerprint = answer.body.f;
    await probe.acceptAnswer(answer.body);
    for (let i = 0; i < 100; i++) {
      const s = await probe.status(rs.peerFingerprint);
      if (s.channel === 'open' || s.connectionState === 'failed') return { channel: s.channel, ms: Math.round(performance.now() - started), selectedPair: s.selectedPair, dtls: s.dtlsVersion, peerCertificateMatches: s.remoteCertificateMatches };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { channel: 'timeout' };
  },

  /** The waiting side answers hellos so that a caller arriving later still finds it. */
  async listen() {
    rs.waiters.push({ predicate: (m) => { if (m.type === 'hello') void send('here', m.from, {}); return false; }, resolve: () => {} });
    return 'listening';
  },

  async status() {
    const s = await probe.status(rs.peerFingerprint);
    return { channel: s.channel, peerCertificateMatches: s.remoteCertificateMatches, log: rs.log, rejected: rs.rejected };
  },

  ping: () => probe.ping(),

  /** Send one more announcement, e.g. after the relay has been idle. */
  say: (type) => send(type, null, {}).then(() => 'sent'),
};
