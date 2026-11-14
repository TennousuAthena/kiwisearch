// Phase 0 probe. Not Kiwi code: a throwaway extension to test browser behaviour.
const api = globalThis.browser ?? globalThis.chrome;
self.__nav = [];
self.__errors = [];

const app = (query) => api.runtime.getURL('/app.html') + query;

async function registerRules() {
  const old = (await api.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  await api.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old,
    addRules: [
      // 1: the rule Kiwi has today (path + query), as the baseline.
      { id: 1, priority: 1, action: { type: 'redirect', redirect: { regexSubstitution: app('?path=\\1') } },
        condition: { regexFilter: '^https://s\\.kiwi\\.moe/s\\?(.*)$', resourceTypes: ['main_frame'] } },
      // 2: regexFilter that tries to match the fragment.
      { id: 2, priority: 1, action: { type: 'redirect', redirect: { regexSubstitution: app('?regexHash=\\1') } },
        condition: { regexFilter: '^https://s\\.kiwi\\.moe/#q=(.*)$', resourceTypes: ['main_frame'] } },
      // 3: urlFilter that tries to match the fragment, on its own host so rules 2 and 3 cannot shadow each other.
      { id: 3, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/app.html?urlFilterHash=1' } },
        condition: { urlFilter: '|https://u.kiwi.moe/#q=', resourceTypes: ['main_frame'] } },
      // 4: a host that never resolves: does the redirect come before DNS?
      { id: 4, priority: 1, action: { type: 'redirect', redirect: { regexSubstitution: app('?inv=\\1') } },
        condition: { regexFilter: '^https://local\\.kiwi\\.invalid/s\\?(.*)$', resourceTypes: ['main_frame'] } },
    ],
  });
}
registerRules().catch((e) => { self.__ruleError = String(e); });

api.webNavigation.onBeforeNavigate.addListener((d) => { if (d.frameId === 0) self.__nav.push({ url: d.url }); });
api.webNavigation.onErrorOccurred.addListener((d) => { if (d.frameId === 0) self.__errors.push({ url: d.url, error: d.error }); });

const resultsPayload = (n) => Array.from({ length: n }, (_, i) => ({
  key: 'https://example.org/page/' + i, url: 'https://example.org/page/' + i + '?utm=probe',
  title: 'Result title number ' + i + ' with some words in it to look real',
  snippet: 'x'.repeat(300), meta: { authors: ['A. Author', 'B. Author'], year: 2024 }, sources: ['google', 'bing', 'brave'], score: 0.5,
}));
const now = () => performance.timeOrigin + performance.now();

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'search') return;
  port.onMessage.addListener(async (m) => {
    if (m.type !== 'search') return;
    const { n = 1500, paceMs = 0, results = 100, spin = false } = m;
    const sendStart = performance.now();
    port.postMessage({ type: 'results', sentAt: now(), results: resultsPayload(results) });
    for (let i = 0; i < n; i++) {
      port.postMessage({ type: 'delta', seq: i, sentAt: now(), text: 'lorem ipsum dolor sit ' + (i % 10) });
      if (paceMs && spin) { const end = performance.now() + paceMs; while (performance.now() < end) { /* busy-wait: no timers involved */ } }
      else if (paceMs) {
        const g0 = performance.now();
        await new Promise((r) => setTimeout(r, paceMs));
        (self.__gaps ??= []).push(+(performance.now() - g0).toFixed(1));
      }
    }
    (self.__runs ??= []).push({ n, paceMs, sendLoopMs: +(performance.now() - sendStart).toFixed(1), via: port.sender?.tab ? 'content-script' : 'extension-page' });
    port.postMessage({ type: 'done', sentAt: now() });
  });
});
