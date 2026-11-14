// The web page: the website path. Handshake, then a stream over the private MessagePort.
const qs = new URLSearchParams(location.search);
const now = () => performance.timeOrigin + performance.now();
const report = (body) => fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  const out = { label: qs.get('label'), path: 'bridge', attrAtStart: window.__attrAtStart, attrNow: document.documentElement.dataset.kiwi ?? null, ua: navigator.userAgent };
  try {
    const n = Number(qs.get('n') || 1500), paceMs = Number(qs.get('pace') || 0);
    const chan = new MessageChannel();
    const port = chan.port1;
    const inbox = [];
    let waiter = null;
    const streamHandlers = new Map();
    port.onmessage = (e) => {
      const m = e.data;
      if (m && m.t === 'msg' && streamHandlers.has(m.ch)) streamHandlers.get(m.ch)(m.data);
      else if (waiter) { const w = waiter; waiter = null; w(m); } else inbox.push(m);
    };
    const next = () => new Promise((res) => { if (inbox.length) res(inbox.shift()); else waiter = res; });

    const tHello = now();
    window.postMessage({ kiwi: 'connect' }, location.origin, [chan.port2]);
    port.postMessage({ t: 'hello', protocols: [1] });
    const welcome = await Promise.race([next(), new Promise((r) => setTimeout(() => r({ timeout: true }), 3000))]);
    out.handshakeMs = now() - tHello;
    out.welcome = welcome;
    if (welcome.timeout) { await report(out); return; }

    const lat = []; let results = 0; let firstAt = 0;
    const t0 = now();
    await new Promise((resolve) => {
      streamHandlers.set(1, (m) => {
        const t = now();
        if (!firstAt) firstAt = t;
        lat.push(t - m.sentAt);
        if (m.type === 'results') results = JSON.stringify(m).length;
        if (m.type === 'done') resolve();
      });
      port.postMessage({ t: 'open', ch: 1, name: 'search' });
      port.postMessage({ t: 'msg', ch: 1, data: { type: 'search', n, paceMs, spin: qs.get('spin') === '1' } });
    });
    Object.assign(out, { n, paceMs, events: lat.length, totalMs: now() - t0, firstEventMs: firstAt - t0, resultsBytes: results, lat });
    try { out.lm = { type: typeof LanguageModel, availability: typeof LanguageModel === 'undefined' ? null : await LanguageModel.availability() }; } catch (e) { out.lm = { error: String(e) }; }
  } catch (e) { out.error = String(e); }
  await report(out);
})();
