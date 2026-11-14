// Firefox only (no CDP there): the extension drives its own navigation checks and reports to the local server.
// Uses `.invalid` hostnames only, so nothing can reach a real server if a rule does not match.
const REPORT = '__REPORT__';
const nav = [];
browser.webNavigation.onErrorOccurred.addListener((d) => { if (d.frameId === 0) nav.push({ url: d.url, error: d.error }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = (q) => browser.runtime.getURL('/app.html') + q;

// Firefox MV3's default CSP upgrades http:// fetches from extension pages, so reports go through a localhost tab's content script (same origin as the server).
// The content script announces itself first, so the tab id comes from the message sender, not from a tabs.query that needs host access.
let relayTab = null;
browser.runtime.onMessage.addListener((m, sender) => { if (m && m.kiwiHello && sender.tab) { relayTab = sender.tab.id; return Promise.resolve({ ok: true, tab: sender.tab.id }); } });
const post = async (body) => {
  for (let i = 0; i < 40 && relayTab === null; i++) await sleep(500);
  if (relayTab !== null) await browser.tabs.sendMessage(relayTab, { kiwiReport: body }).catch(() => {});
};
post({ label: 'ff-selftest-start' });
(async () => {
  await sleep(2000); // let background.js finish its own rule registration first
  const out = { label: 'ff-selftest', ruleError: null, cases: [] };
  try {
    await browser.declarativeNetRequest.updateDynamicRules({
      addRules: [
        { id: 11, priority: 1, action: { type: 'redirect', redirect: { regexSubstitution: app('?regexHash=\\1') } },
          condition: { regexFilter: '^https://frag\\.kiwi\\.invalid/#q=(.*)$', resourceTypes: ['main_frame'] } },
        { id: 12, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/app.html?urlFilterHash=1' } },
          condition: { urlFilter: '|https://frag2.kiwi.invalid/#q=', resourceTypes: ['main_frame'] } },
        { id: 13, priority: 1, action: { type: 'redirect', redirect: { regexSubstitution: app('?path=\\1') } },
          condition: { regexFilter: '^https://path\\.kiwi\\.invalid/s\\?(.*)$', resourceTypes: ['main_frame'] } },
      ],
    });
  } catch (e) { out.ruleError = String(e); }
  const urls = [
    'https://path.kiwi.invalid/s?q=hello%20world',
    'https://frag.kiwi.invalid/#q=hello%20world',
    'https://frag2.kiwi.invalid/#q=hello',
    'https://local.kiwi.invalid/s?q=abc',
    'https://nope.kiwi.invalid/#q=hello',
  ];
  for (const url of urls) {
    try {
      const tab = await browser.tabs.create({ url, active: false });
      await sleep(2500);
      const t = await browser.tabs.get(tab.id);
      out.cases.push({ url, final: t.url, title: t.title });
      await browser.tabs.remove(tab.id);
    } catch (e) { out.cases.push({ url, error: String(e) }); }
  }
  out.errors = nav;
  try { out.permissions = await browser.permissions.getAll(); } catch (e) { out.permissionsError = String(e); }
  await post(out);
})().catch((e) => post({ label: 'ff-selftest', fatal: String(e) }));
