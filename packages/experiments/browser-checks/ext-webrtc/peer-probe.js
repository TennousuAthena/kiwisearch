// PeerJS in the offscreen document, for the evaluation in docs/internals/device-sync.md. `peerjs.min.js` is not committed:
// ../peerjs-check.mjs copies it from tools/ into a temporary copy of this folder. Returns kinds of addresses, never addresses.
const pj = { peer: null, conn: null, received: [], errors: [] };

function wire(conn) {
  pj.conn = conn;
  conn.on('data', (d) => { pj.received.push(typeof d === 'string' ? d : '[binary]'); if (d === 'ping') conn.send('pong'); });
  conn.on('error', (e) => pj.errors.push('conn: ' + (e.type ?? String(e))));
}

self.pjProbe = {
  /** The ICE servers PeerJS uses when the application passes none. */
  defaults() {
    const peer = new Peer('defaults-probe', { host: '127.0.0.1', port: 9, path: '/', key: 'x', secure: false, debug: 0 });
    peer.on('error', () => {});
    const servers = peer.options.config.iceServers.map((s) => ({ urls: s.urls, hasCredential: !!s.credential }));
    peer.destroy();
    return servers;
  },

  start(server, id, iceServers) {
    pj.peer = new Peer(id, { ...server, secure: false, debug: 0, config: { iceServers } });
    pj.peer.on('connection', wire);
    pj.peer.on('error', (e) => pj.errors.push(e.type));
    return new Promise((resolve) => {
      pj.peer.on('open', (got) => resolve({ open: got === id }));
      pj.peer.on('error', (e) => resolve({ error: e.type }));
      setTimeout(() => resolve({ timeout: true }), 10000);
    });
  },

  connect(id) {
    const started = performance.now();
    const conn = pj.peer.connect(id, { serialization: 'raw', reliable: true });
    wire(conn);
    return new Promise((resolve) => {
      conn.on('open', () => resolve({ openMs: Math.round(performance.now() - started) }));
      conn.on('error', (e) => resolve({ error: e.type ?? String(e) }));
      setTimeout(() => resolve({ timeout: true }), 15000);
    });
  },

  async ping() {
    const before = pj.received.length;
    pj.conn.send('ping');
    for (let i = 0; i < 50 && !pj.received.slice(before).includes('pong'); i++) await new Promise((r) => setTimeout(r, 100));
    return pj.received.slice(before).includes('pong');
  },

  async status() {
    const pc = pj.conn?.peerConnection;
    const out = { open: pj.conn?.open ?? false, received: pj.received, errors: pj.errors };
    if (!pc) return out;
    const stats = await pc.getStats();
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) {
        const pair = stats.get(s.selectedCandidatePairId);
        const l = stats.get(pair.localCandidateId);
        const r = stats.get(pair.remoteCandidateId);
        out.selectedPair = `${l.candidateType}/${addressKind(l.address ?? '')} -> ${r.candidateType}/${addressKind(r.address ?? '')}`;
        out.dtls = s.tlsVersion;
      }
    });
    return out;
  },

  destroy() { pj.peer?.destroy(); return 'destroyed'; },
};
