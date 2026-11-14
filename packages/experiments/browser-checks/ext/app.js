// Extension page: the direct path (what the extension's own interface does today).
const api = globalThis.browser ?? globalThis.chrome;
const qs = new URLSearchParams(location.search);
const now = () => performance.timeOrigin + performance.now();

async function report(body) {
  await fetch(qs.get('report') || 'http://localhost/none', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

if (qs.get('run') === 'direct') {
  (async () => {
    const n = Number(qs.get('n') || 1500), paceMs = Number(qs.get('pace') || 0);
    const lat = []; let results = 0; let firstAt = 0;
    const t0 = now();
    const port = api.runtime.connect({ name: 'search' });
    await new Promise((resolve) => {
      port.onMessage.addListener((m) => {
        const t = now();
        if (!firstAt) firstAt = t;
        lat.push(t - m.sentAt);
        if (m.type === 'results') results = JSON.stringify(m).length;
        if (m.type === 'done') resolve();
      });
      port.postMessage({ type: 'search', n, paceMs, spin: qs.get('spin') === '1' });
    });
    let lm = null;
    try { lm = { type: typeof LanguageModel, availability: typeof LanguageModel === 'undefined' ? null : await LanguageModel.availability() }; } catch (e) { lm = { error: String(e) }; }
    await report({ label: qs.get('label'), path: 'direct', n, paceMs, events: lat.length, totalMs: now() - t0, firstEventMs: firstAt - t0, resultsBytes: results, lat, lm });
  })();
}
