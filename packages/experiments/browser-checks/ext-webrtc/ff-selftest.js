// Firefox (Manifest V2 background page): the same checks as the Chromium offscreen document, run on start-up and reported to the
// local check server. Two connections in this one page stand in for two devices; only the compact codes pass between them.
(async () => {
  const out = { ua: navigator.userAgent.match(/Firefox\/[\d.]+/)?.[0], RTCPeerConnection: typeof self.RTCPeerConnection };
  try {
    out.crypto = await cryptoProbe();
    out.munging = await probe.mungeTest();
    const cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256', expires: 10 * 365 * 86400e3 });
    out.certExpiresInDays = Math.round((cert.expires - Date.now()) / 86400e3);
    try {
      await idbPut('ff-cert', cert);
      const back = await idbGet('ff-cert');
      out.certInIndexedDb = back.getFingerprints()[0].value === cert.getFingerprints()[0].value;
    } catch (e) { out.certInIndexedDb = String(e); }

    const other = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    // One device per certificate, as in the design; `full` passes whole descriptions instead of compact codes, to tell the two apart.
    const connect = async (full) => {
      const peer = (c) => { const pc = new RTCPeerConnection({ iceServers: [], certificates: [c] }); return { pc, dc: pc.createDataChannel('sync', { negotiated: true, id: 0 }) }; };
      const a = peer(cert);
      const b = peer(other);
      const r = {};
      const done = new Promise((resolve) => { b.dc.onmessage = (ev) => resolve(ev.data); });
      await a.pc.setLocalDescription();
      await gathered(a.pc);
      const offer = compact(a.pc.localDescription.sdp);
      r.candidates = offer.c.map(([address, , typ]) => `${typ}/${addressKind(address)}`);
      r.fullSdpBytes = a.pc.localDescription.sdp.length;
      await b.pc.setRemoteDescription(full ? a.pc.localDescription : { type: 'offer', sdp: expand(offer, 'offer') });
      await b.pc.setLocalDescription();
      await gathered(b.pc);
      await a.pc.setRemoteDescription(full ? b.pc.localDescription : { type: 'answer', sdp: expand(compact(b.pc.localDescription.sdp), 'answer') });
      const started = performance.now();
      const opened = await Promise.race([new Promise((resolve) => { a.dc.onopen = () => resolve(true); }), new Promise((resolve) => setTimeout(() => resolve(false), 10000))]);
      r.openMs = opened ? Math.round(performance.now() - started) : null;
      r.ice = a.pc.iceConnectionState;
      r.dtls = a.pc.sctp?.transport?.state ?? null;
      if (opened) { a.dc.send('hello'); r.message = await done; }
      const stats = await a.pc.getStats();
      r.pairs = [];
      stats.forEach((s) => { if (s.type === 'candidate-pair') {
        const l = stats.get(s.localCandidateId); const rc = stats.get(s.remoteCandidateId);
        r.pairs.push(`${l?.candidateType}/${addressKind(l?.address ?? '')} -> ${rc?.candidateType}/${addressKind(rc?.address ?? '')}: ${s.state}${s.nominated ? ' nominated' : ''}`);
      } });
      r.maxMessageSize = a.pc.sctp?.maxMessageSize ?? null;
      r.getRemoteCertificates = typeof a.pc.sctp?.transport?.getRemoteCertificates;
      a.pc.close(); b.pc.close();
      return r;
    };
    out.fullDescriptions = await connect(true);
    out.compactCodes = await connect(false);
  } catch (e) { out.error = String(e); }
  await fetch('__REPORT__', { method: 'POST', body: JSON.stringify({ label: 'ff-webrtc', ...out }) });
})();
