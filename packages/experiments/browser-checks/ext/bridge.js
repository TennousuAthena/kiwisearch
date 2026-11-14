// Content script prototype: page <-> MessagePort <-> runtime.connect. Mirrors section 3 of the plan.
const api = globalThis.browser ?? globalThis.chrome;
document.documentElement.dataset.kiwi = '1';

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin || !e.data || e.data.kiwi !== 'connect') return;
  const port = e.ports && e.ports[0];
  if (!port) return;
  const streams = new Map();
  port.onmessage = (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') port.postMessage({ t: 'welcome', protocol: 1, ext: api.runtime.getManifest().version, caps: ['search'] });
    else if (m.t === 'open') {
      const p = api.runtime.connect({ name: m.name });
      streams.set(m.ch, p);
      p.onMessage.addListener((data) => port.postMessage({ t: 'msg', ch: m.ch, data }));
      p.onDisconnect.addListener(() => port.postMessage({ t: 'close', ch: m.ch }));
    } else if (m.t === 'msg') streams.get(m.ch)?.postMessage(m.data);
    else if (m.t === 'close') { streams.get(m.ch)?.disconnect(); streams.delete(m.ch); }
  };
});

// Test plumbing only: lets the background hand a report to this page's own origin.
api.runtime.onMessage.addListener((m) => {
  if (m && m.kiwiReport) fetch('/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m.kiwiReport) });
});

api.runtime.sendMessage({ kiwiHello: true }).then((r) => fetch('/report', { method: 'POST', body: JSON.stringify({ label: 'ff-hello', r }) }), (e) => fetch('/report', { method: 'POST', body: JSON.stringify({ label: 'ff-hello', err: String(e) }) }));
