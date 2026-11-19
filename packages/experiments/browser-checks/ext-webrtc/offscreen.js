// The WebRTC side of the device-sync probe, run in a Chrome offscreen document (reason WEB_RTC).
// Driven over CDP by ../webrtc-check.mjs: each function returns plain JSON. Addresses are never returned, only their kind.

// One connection per remote device: `probe.use(peer)` picks whose connection the calls after it act on, so a third device joining
// does not replace the connection to the second. Without `use` there is a single unnamed connection, as the two-device checks expect.
const fresh = () => ({ pc: null, dc: null, received: 0, receivedBytes: 0, pongs: [], log: [], answerAt: undefined });
const slots = new Map();
let state = fresh();
let certificate = null;

/** The device's long-lived DTLS certificate: generated once and kept in IndexedDB, so its fingerprint can be pinned by paired devices. */
async function loadCertificate() {
  let cert = await idbGet('dtls-cert');
  let created = false;
  if (!cert) {
    const requested = Date.now() + 10 * 365 * 86400e3;
    cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256', expires: 10 * 365 * 86400e3 });
    await idbPut('dtls-cert', cert);
    await idbPut('dtls-cert-requested-expiry', requested);
    created = true;
  }
  certificate = cert;
  const requested = await idbGet('dtls-cert-requested-expiry');
  return {
    created,
    fingerprint: cert.getFingerprints()[0].value.toUpperCase(),
    expiresInDays: Math.round((cert.expires - Date.now()) / 86400e3),
    requestedDays: Math.round((requested - Date.now()) / 86400e3),
  };
}

const PRIORITY = { host: 2113937151, srflx: 1677729535, prflx: 1845501695, relay: 41885439 };

function addressKind(address) {
  if (address.endsWith('.local')) return 'mdns';
  return address.includes(':') ? 'ipv6' : 'ipv4';
}

/** Keep only what the other side cannot know: ICE credentials, the DTLS fingerprint and the UDP candidates. */
function compact(sdp) {
  const candidates = [...sdp.matchAll(/a=candidate:\S+ \d (udp) \d+ (\S+) (\d+) typ (\w+)/gi)].map((m) => [m[2], Number(m[3]), m[4]]);
  return {
    u: sdp.match(/a=ice-ufrag:(\S+)/)[1],
    p: sdp.match(/a=ice-pwd:(\S+)/)[1],
    f: sdp.match(/a=fingerprint:sha-256 (\S+)/i)[1].toUpperCase(),
    c: candidates,
  };
}

/** Rebuild a full session description from the compact form. The role is implied: the offer is `actpass`, the answer `active`. */
function expand(code, type) {
  const lines = [
    'v=0', `o=- ${Math.floor(Math.random() * 1e15)} 2 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${code.u}`, `a=ice-pwd:${code.p}`, 'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${code.f}`, `a=setup:${type === 'offer' ? 'actpass' : 'active'}`, 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
    ...code.c.map(([address, port, typ], i) => `a=candidate:${i + 1} 1 udp ${PRIORITY[typ] ?? PRIORITY.host} ${address} ${port} typ ${typ}${typ === 'host' ? '' : ' raddr 0.0.0.0 rport 0'}`),
    // A description with no candidates at all (the one-way case) leaves ICE open to peer-reflexive candidates from incoming checks.
    ...(code.c.length ? ['a=end-of-candidates'] : []),
  ];
  return lines.join('\r\n') + '\r\n';
}

const current = () => state;

function newPeer(iceServers) {
  // The handlers keep writing to the connection they belong to after `use` has moved on to another device.
  const state = current();
  const pc = new RTCPeerConnection({ iceServers, certificates: [certificate] });
  const dc = pc.createDataChannel('sync', { negotiated: true, id: 0 });
  dc.binaryType = 'arraybuffer';
  dc.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      if (ev.data.startsWith('ping:')) dc.send('pong:' + ev.data.slice(5));
      else if (ev.data.startsWith('pong:')) state.pongs.push(performance.now() - Number(ev.data.slice(5)));
      return;
    }
    state.received += 1;
    state.receivedBytes += ev.data.byteLength;
  };
  pc.onconnectionstatechange = () => state.log.push([Math.round(performance.now()), 'pc', pc.connectionState]);
  dc.onopen = () => state.log.push([Math.round(performance.now()), 'dc', 'open']);
  dc.onclose = () => state.log.push([Math.round(performance.now()), 'dc', 'close']);
  state.pc = pc;
  state.dc = dc;
  return pc;
}

function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); }));
}

async function describeLocal(pc, started) {
  await gathered(pc);
  const sdp = pc.localDescription.sdp;
  const code = compact(sdp);
  return {
    code,
    gatherMs: Math.round(performance.now() - started),
    fullSdpBytes: sdp.length,
    compactJsonBytes: JSON.stringify(code).length,
    candidates: code.c.map(([address, , typ]) => `${typ}/${addressKind(address)}`),
  };
}

self.probe = {
  loadCertificate,

  /** Act on the connection to this device from now on. Call it right before another probe call, with no `await` in between. */
  use(peer) {
    if (!slots.has(peer)) slots.set(peer, fresh());
    state = slots.get(peer);
    return peer;
  },
  cryptoProbe,

  async makeOffer(iceServers = []) {
    const started = performance.now();
    const pc = newPeer(iceServers);
    await pc.setLocalDescription();
    return describeLocal(pc, started);
  },

  async acceptOffer(code, iceServers = []) {
    const started = performance.now();
    const pc = newPeer(iceServers);
    await pc.setRemoteDescription({ type: 'offer', sdp: expand(code, 'offer') });
    await pc.setLocalDescription();
    return describeLocal(pc, started);
  },

  async acceptAnswer(code) {
    state.answerAt = performance.now();
    await state.pc.setRemoteDescription({ type: 'answer', sdp: expand(code, 'answer') });
    return 'ok';
  },

  /** Connection state, the selected candidate pair (kinds only) and whether the peer's certificate is the one the code promised. */
  async status(expectedFingerprint) {
    const state = current();
    const pc = state.pc;
    const out = { connectionState: pc?.connectionState, channel: state.dc?.readyState, received: state.received, receivedBytes: state.receivedBytes, log: state.log };
    if (!pc) return out;
    out.maxMessageSize = pc.sctp?.maxMessageSize ?? null;
    const stats = await pc.getStats();
    let pair;
    stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
    if (pair) {
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      out.selectedPair = { local: `${local.candidateType}/${addressKind(local.address ?? '')}`, remote: `${remote.candidateType}/${addressKind(remote.address ?? '')}`, rttMs: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null };
      stats.forEach((s) => { if (s.type === 'transport') { out.dtlsVersion = s.tlsVersion ?? null; out.dtlsCipher = s.dtlsCipher ?? null; out.srtpCipher = s.srtpCipher ?? null; } });
    }
    if (state.answerAt && state.log.some(([, k, v]) => k === 'dc' && v === 'open')) {
      const opened = state.log.find(([, k, v]) => k === 'dc' && v === 'open')[0];
      out.answerToOpenMs = Math.round(opened - state.answerAt);
    }
    const dtls = pc.sctp?.transport;
    if (dtls?.getRemoteCertificates) {
      const certs = dtls.getRemoteCertificates();
      if (certs.length) {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', certs[0]));
        const hex = [...digest].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
        out.remoteCertificateMatches = expectedFingerprint ? hex === expectedFingerprint : null;
      } else out.remoteCertificateMatches = 'no certificates';
    } else out.remoteCertificateMatches = 'getRemoteCertificates unavailable';
    return out;
  },

  async ping() {
    const state = current();
    const before = state.pongs.length;
    state.dc.send('ping:' + performance.now());
    for (let i = 0; i < 50 && state.pongs.length === before; i++) await new Promise((r) => setTimeout(r, 100));
    return state.pongs.length > before ? Math.round(state.pongs[state.pongs.length - 1] * 10) / 10 : null;
  },

  /** Send `total` bytes in `chunk`-byte messages, pausing while the send buffer is above 1 MB. */
  async bulk(total, chunk) {
    const dc = state.dc;
    const started = performance.now();
    const buf = new Uint8Array(chunk);
    dc.bufferedAmountLowThreshold = 256 * 1024;
    for (let sent = 0; sent < total; sent += chunk) {
      if (dc.bufferedAmount > 1024 * 1024) await new Promise((r) => { dc.onbufferedamountlow = () => r(); });
      dc.send(buf);
    }
    while (dc.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 10));
    return { ms: Math.round(performance.now() - started) };
  },

  reset() {
    state.pc?.close();
    Object.assign(state, fresh());
    return 'reset';
  },

  /**
   * One-way reconnection between devices that already trust each other: both sides know (here: are given; in the design: derive from the
   * shared key and a nonce) the ICE credentials of both, and each other's pinned certificate fingerprint. Only the offerer's candidates
   * cross; the answerer sends nothing back, and the offerer builds the answer itself and learns the answerer's address from its checks.
   */
  async oneWayOffer(creds, iceServers = []) {
    const started = performance.now();
    const pc = newPeer(iceServers);
    const offer = await pc.createOffer();
    await pc.setLocalDescription({ type: 'offer', sdp: offer.sdp.replace(/a=ice-ufrag:\S+/g, `a=ice-ufrag:${creds.u}`).replace(/a=ice-pwd:\S+/g, `a=ice-pwd:${creds.p}`) });
    return describeLocal(pc, started);
  },

  async oneWayAccept(code, creds, iceServers = []) {
    const pc = newPeer(iceServers);
    await pc.setRemoteDescription({ type: 'offer', sdp: expand(code, 'offer') });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription({ type: 'answer', sdp: answer.sdp.replace(/a=ice-ufrag:\S+/g, `a=ice-ufrag:${creds.u}`).replace(/a=ice-pwd:\S+/g, `a=ice-pwd:${creds.p}`) });
    return 'waiting';
  },

  async oneWaySynthesizeAnswer(creds, fingerprint) {
    state.answerAt = performance.now();
    await state.pc.setRemoteDescription({ type: 'answer', sdp: expand({ u: creds.u, p: creds.p, f: fingerprint, c: [] }, 'answer') });
    return 'ok';
  },

  /** Can the local description's ICE credentials or fingerprint be rewritten (SDP munging)? */
  async mungeTest() {
    const out = {};
    for (const [name, edit] of [
      ['ice-ufrag/pwd', (sdp) => sdp.replace(/a=ice-ufrag:\S+/g, 'a=ice-ufrag:kiwi').replace(/a=ice-pwd:\S+/g, 'a=ice-pwd:kiwikiwikiwikiwikiwikiwi')],
      ['fingerprint', (sdp) => sdp.replace(/a=fingerprint:sha-256 \S+/i, 'a=fingerprint:sha-256 ' + Array(32).fill('AB').join(':'))],
    ]) {
      const pc = new RTCPeerConnection();
      pc.createDataChannel('x');
      const offer = await pc.createOffer();
      try {
        await pc.setLocalDescription({ type: 'offer', sdp: edit(offer.sdp) });
        out[name] = name === 'fingerprint' ? 'accepted' : (pc.localDescription.sdp.includes('a=ice-ufrag:kiwi') ? 'accepted and used' : 'accepted but ignored');
      } catch (e) { out[name] = 'rejected: ' + String(e).slice(0, 160); }
      pc.close();
    }
    return out;
  },
};
