// Manual two-device check: the same compact codes as webrtc-check.mjs, carried by the person running it.
const $ = (id) => document.getElementById(id);
const encode = (obj) => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (text) => JSON.parse(atob(text.trim().replace(/-/g, '+').replace(/_/g, '/')));
const iceServers = () => ($('stun').value.trim() ? [{ urls: $('stun').value.trim() }] : []);
let peerFingerprint;
let created = false;

async function show() {
  const s = await probe.status(peerFingerprint);
  $('status').textContent = JSON.stringify({ connection: s.connectionState, channel: s.channel, selectedPair: s.selectedPair, dtls: s.dtlsVersion, peerCertificateMatchesCode: s.remoteCertificateMatches, log: s.log }, null, 1);
}

$('create').onclick = async () => {
  await probe.loadCertificate();
  probe.reset();
  const offer = await probe.makeOffer(iceServers());
  created = true;
  $('mine').value = encode({ t: 'offer', ...offer.code });
  $('status').textContent = `code ready: ${offer.candidates.join(', ') || 'no candidates'} (gathered in ${offer.gatherMs} ms)`;
};

$('use').onclick = async () => {
  try {
    const { t, ...code } = decode($('theirs').value);
    peerFingerprint = code.f;
    await probe.loadCertificate();
    if (t === 'offer') {
      probe.reset();
      const answer = await probe.acceptOffer(code, iceServers());
      $('mine').value = encode({ t: 'answer', ...answer.code });
      $('status').textContent = `reply ready: ${answer.candidates.join(', ') || 'no candidates'}; send it back to the first device`;
    } else if (t === 'answer' && created) {
      await probe.acceptAnswer(code);
    } else throw new Error('expected an offer, or an answer to the code created here');
    setInterval(show, 500);
  } catch (e) { $('status').textContent = 'error: ' + e.message; }
};

$('ping').onclick = async () => { $('status').textContent = `ping: ${await probe.ping()} ms\n` + $('status').textContent; };
