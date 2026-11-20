// Encrypted signaling through a relay that only forwards opaque frames (apps/relay), for docs/internals/device-sync.md.
// Runs in the offscreen document next to offscreen.js (probe.makeOffer/acceptOffer/acceptAnswer/status).
//
// Keys come from a 32-byte group secret (in the design: the entropy behind the 24-word recovery phrase) through HKDF:
//   topic key  -> the relay topic id, an HMAC of the UTC day, so the id the relay sees changes daily;
//   signal key -> AES-256-GCM over every frame, with the topic id as associated data.
// A frame is nonce (12) || ciphertext of a JSON message padded to a fixed size, so the relay learns neither the content nor its length.
// Messages carry a random id and a time; repeats and old messages are dropped.
//
// Any number of devices can share a topic. Each pair gets its own peer connection, and for each pair the device with the smaller id
// offers, so two devices that announce themselves at the same time never offer to each other at once. A device that joins sends
// `hello`; a device with a smaller id answers with an offer, one with a larger id answers `here` and is then offered to.

const FRAME_PLAINTEXT = 1536;
const MAX_AGE_MS = 120_000;
const rs = { ws: null, keys: null, topic: null, device: null, seen: new Set(), log: [], rejected: [], waiters: [], peers: new Map() };

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

/** `re` names the message this one answers, so an answer is never applied to another offer. Resolves to the new message's id. */
function send(type, to, body, re) {
  const id = b64url(crypto.getRandomValues(new Uint8Array(12)));
  // A device never acts on its own messages, even when someone sends them back to it.
  rs.seen.add(id);
  return seal({ type, from: rs.device, to, body, id, re, t: Date.now() }).then((frame) => { rs.ws.send(frame); return id; });
}

function waitFor(predicate, ms = 15000) {
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve };
    rs.waiters.push(waiter);
    setTimeout(() => {
      const at = rs.waiters.indexOf(waiter);
      if (at < 0) return;
      rs.waiters.splice(at, 1);
      reject(new Error('timed out waiting for a relay message'));
    }, ms);
  });
}

/** The connection to one device: its pinned fingerprint and a promise that settles when the data channel is open or has failed. */
function track(peer, started) {
  const entry = { fingerprint: null, started, result: null };
  rs.peers.set(peer, entry);
  entry.done = (async () => {
    for (let i = 0; i < 150; i++) {
      if (rs.peers.get(peer) !== entry) return (entry.result = { channel: 'replaced' });
      if (entry.fingerprint) {
        probe.use(peer);
        const s = await probe.status(entry.fingerprint);
        if (s.channel === 'open' || s.connectionState === 'failed') return (entry.result = { channel: s.channel, ms: Math.round(performance.now() - started), selectedPair: s.selectedPair, dtls: s.dtlsVersion, peerCertificateMatches: s.remoteCertificateMatches });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return (entry.result = { channel: 'timeout' });
  })();
  return entry;
}

async function offerTo(peer) {
  const entry = track(peer, performance.now());
  probe.use(peer);
  probe.reset();
  const offer = await probe.makeOffer([]);
  const id = await send('offer', peer, offer.code);
  const answer = await waitFor((m) => m.type === 'answer' && m.from === peer && m.re === id);
  if (rs.peers.get(peer) !== entry) return;
  probe.use(peer);
  await probe.acceptAnswer(answer.body);
  entry.fingerprint = answer.body.f;
}

const offers = (peer) => rs.device < peer;
const pending = (peer) => rs.peers.has(peer) && !rs.peers.get(peer).result;

async function onFrame(data) {
  if (typeof data === 'string') return rs.rejected.push('text frame');
  const { message, rejected } = await open(data);
  if (rejected) return rs.rejected.push(rejected);
  if (message.to && message.to !== rs.device) return;
  const peer = message.from;
  rs.log.push([Math.round(performance.now()), message.type, peer]);
  if (message.type === 'hello') {
    // A hello means the device has no connection to anyone yet, so an older one to it is replaced; the others are left alone.
    if (offers(peer)) void offerTo(peer).catch((e) => rs.log.push([Math.round(performance.now()), 'offer failed', String(e)]));
    else void send('here', peer, {});
  }
  if (message.type === 'here' && offers(peer) && !pending(peer)) void offerTo(peer).catch((e) => rs.log.push([Math.round(performance.now()), 'offer failed', String(e)]));
  // Answer an offer addressed to this device. Only the connection to its sender is replaced.
  if (message.type === 'offer' && !offers(peer)) {
    const entry = track(peer, performance.now());
    probe.use(peer);
    probe.reset();
    const answer = await probe.acceptOffer(message.body, []);
    await send('answer', peer, answer.code, message.id);
    entry.fingerprint = message.body.f;
  }
  for (const waiter of [...rs.waiters]) {
    if (waiter.predicate(message)) { rs.waiters.splice(rs.waiters.indexOf(waiter), 1); waiter.resolve(message); }
  }
}

/** The device meant when a call names none: the first one this device connected to. */
const firstPeer = () => rs.peers.keys().next().value;

self.relay = {
  async join(url, secretB64, device, day = Math.floor(Date.now() / 86400e3)) {
    await probe.loadCertificate();
    rs.keys = await deriveKeys(fromB64url(secretB64));
    rs.topic = await topicFor(rs.keys, day);
    rs.device = device;
    rs.ws = new WebSocket(`${url}/v1/${rs.topic}`);
    rs.ws.binaryType = 'arraybuffer';
    rs.ws.onmessage = (ev) => { onFrame(ev.data).catch((e) => rs.log.push([Math.round(performance.now()), 'frame failed', String(e)])); };
    rs.ws.onclose = (ev) => rs.log.push([Math.round(performance.now()), 'relay closed', ev.code]);
    await new Promise((resolve, reject) => { rs.ws.onopen = resolve; rs.ws.onerror = () => reject(new Error('relay connection failed')); });
    return { topic: rs.topic };
  },

  /**
   * Announce and connect to every device already in the topic; returns when each data channel is open or has failed. The first device's
   * result is at the top level, all of them are under `peers`. `settleMs` is how long to keep waiting for further devices to appear.
   */
  async call(settleMs = 600) {
    await send('hello', null, {});
    for (let i = 0; i < 150 && !rs.peers.size; i++) await new Promise((r) => setTimeout(r, 100));
    if (!rs.peers.size) throw new Error('timed out waiting for a relay message');
    await new Promise((r) => setTimeout(r, settleMs));
    const peers = {};
    for (const [peer, entry] of rs.peers) peers[peer] = await entry.done;
    return { ...peers[firstPeer()], peers };
  },

  /** Kept for the scripts that call it: a joined device always answers hellos, so a caller arriving later finds it. */
  async listen() {
    return 'listening';
  },

  async status(peer = firstPeer()) {
    const peers = {};
    for (const [id, entry] of rs.peers) {
      probe.use(id);
      const s = await probe.status(entry.fingerprint);
      peers[id] = { channel: s.channel, peerCertificateMatches: s.remoteCertificateMatches, receivedBytes: s.receivedBytes };
    }
    return { channel: peers[peer]?.channel, peerCertificateMatches: peers[peer]?.peerCertificateMatches, peers, log: rs.log, rejected: rs.rejected };
  },

  ping(peer = firstPeer()) {
    probe.use(peer);
    return probe.ping();
  },

  /** Send `total` bytes to one device over its data channel. */
  bulk(peer, total, chunk = 16384) {
    probe.use(peer);
    return probe.bulk(total, chunk);
  },

  /** Send one more announcement, e.g. after the relay has been idle. */
  say: (type) => send(type, null, {}).then(() => 'sent'),
};
