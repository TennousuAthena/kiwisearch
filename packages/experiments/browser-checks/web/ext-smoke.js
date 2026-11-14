// A web page using the real protocol client against the built extension.
const { createBridgeClient } = KiwiProtocol;
const out = { label: 'ext-smoke', origin: location.origin, attrAtStart: window.__attrAtStart, steps: {} };
const report = () => fetch('/report', { method: 'POST', body: JSON.stringify(out) });
const step = async (name, fn) => { try { out.steps[name] = await fn(); } catch (e) { out.steps[name] = { error: { code: e.code, message: String(e.message).slice(0, 160) } }; } };
(async () => {
  const chan = new MessageChannel();
  window.postMessage({ kiwi: 'connect' }, location.origin, [chan.port2]);
  const client = createBridgeClient(chan.port1);
  const pushes = [];
  client.onPush((name, data) => pushes.push({ name, data }));
  const t0 = performance.now();
  out.hello = await client.hello(3000);
  out.helloMs = +(performance.now() - t0).toFixed(1);
  if (out.hello.state === 'ok') {
    await step('prefsLoad', () => client.request('prefs.load'));
    await step('academicLoad', () => client.request('academicLanguage.load'));
    await step('favicon', () => client.request('favicon', { host: 'example.com' }, 20000));
    await step('badFavicon', () => client.request('favicon', { host: 'a/b' }));
    await step('unknownMethod', () => client.request('config.load'));
    await step('settingsPatchSmuggled', () => client.request('domainPreference', { action: 'block', domain: 'smoke-test-invalid.example', config: [{ path: ['llm', 'apiKey'], value: 'x' }] }));
    await step('badPrefs', () => client.request('prefs.save', { values: { config: { x: 1 } } }));
    await step('prefsSave', () => client.request('prefs.save', { values: { 'ui:recentQueries': false } }));
    await new Promise((r) => setTimeout(r, 800));
    out.pushes = pushes;
    await step('prefsSaveBack', () => client.request('prefs.save', { values: { 'ui:recentQueries': true } }));
    // a search stream; all outside names are unresolvable in this test, so sources fail, but the stream must work end to end
    await step('search', () => new Promise((resolve, reject) => {
      const s = client.connect('search');
      const types = {}; let first = null; const t1 = performance.now();
      const timer = setTimeout(() => reject(new Error('stream timeout')), 30000);
      s.onMessage.addListener((m) => {
        const key = m.type === 'event' ? 'event:' + m.event.type : m.type;
        types[key] = (types[key] || 0) + 1;
        if (first === null) first = +(performance.now() - t1).toFixed(1);
        if (m.type === 'fatal' || (m.type === 'event' && m.event.type === 'done')) { clearTimeout(timer); resolve({ firstMs: first, totalMs: +(performance.now() - t1).toFixed(0), types }); s.disconnect(); }
      });
      s.onDisconnect.addListener(() => { clearTimeout(timer); resolve({ closed: true, types }); });
      s.postMessage({ type: 'search', query: 'smoke test query', mode: 'web' });
    }));
    await step('badSearch', () => new Promise((resolve) => {
      const s = client.connect('search');
      s.onMessage.addListener((m) => { resolve(m); s.disconnect(); });
      s.postMessage({ type: 'search', query: 'x', sources: ['../x'] });
      setTimeout(() => resolve('no answer'), 4000);
    }));
    await step('openLocalShape', () => client.request('openLocal', { query: 'x', mode: 'admin' }));
  }
  await report();
  client.close();
})();
