// Interface source in a throwaway headless Chromium: the redirects, the website handshake and cutting a connected page.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { sleep, startServers, launchChromium, newTab, targetInfo, findExtension, evalIn } from './lib.mjs';
const build = process.argv[2];
const S = await startServers({ httpPort: 18765 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-p0-ext-')); fs.cpSync(build, dir, { recursive: true });
const b = await launchChromium({ ext: dir, httpsPort: S.httpsPort });
const out = { site: {}, local: {} };
const hits = (mark) => S.log.slice(mark).filter((e) => e.srv === 'https').map((e) => e.host + e.url);
async function go(url) {
  const tab = await newTab(b.browser, 'about:blank'); await tab.send('Page.enable');
  const mark = S.log.length;
  await tab.send('Page.navigate', { url }); await sleep(1600);
  const info = await targetInfo(b.browser, tab.targetId);
  await b.browser.send('Target.closeTarget', { targetId: tab.targetId });
  return { final: String(info?.url).replace(/chrome-extension:\/\/[a-z]+/, 'EXT'), serverHits: hits(mark) };
}
try {
  const ext = await findExtension(b.browser); await sleep(1500);
  const setSource = async (v) => { await evalIn(b.browser, ext.targetId, `chrome.storage.local.set({ uiSource: ${JSON.stringify(v)} })`); await sleep(1200); };
  const rules = async () => evalIn(b.browser, ext.targetId, `chrome.declarativeNetRequest.getDynamicRules().then(r => JSON.stringify(r.map(x => x.id).sort()))`);
  // ---- site mode (the default)
  out.site.rules = await rules();
  out.site.legacy = await go('https://s.kiwi.moe/s?q=hello+world&m=news');
  out.site.hash = await go('https://s.kiwi.moe/#q=hello%20world');
  // the website talks to the extension, and holds a stream open
  const page = await newTab(b.browser, 'http://localhost:18765/ext-smoke.html');
  out.site.pageReport = await S.waitReport((r) => r.label === 'ext-smoke' && r.origin === 'http://localhost:18765', 60000).then((r) => ({ hello: r.hello.state, search: r.steps.search?.types }));
  await b.browser.send('Target.closeTarget', { targetId: page.targetId });
  // ---- local mode
  await setSource('local');
  out.local.rules = await rules();
  out.local.legacy = await go('https://s.kiwi.moe/s?q=hello+world');
  out.local.hash = await go('https://s.kiwi.moe/#q=hello%20world');
  out.local.hashAndOtherParams = await go('https://s.kiwi.moe/#m=news&q=a&b');
  out.local.root = await go('https://s.kiwi.moe/');
  out.local.otherHost = await go('https://u.kiwi.moe/#q=x');
  // the website now gets "disabled"
  S.reports.length = 0;
  const page2 = await newTab(b.browser, 'http://localhost:18765/ext-smoke.html');
  out.local.pageReport = await S.waitReport((r) => r.label === 'ext-smoke' && r.origin === 'http://localhost:18765', 60000).then((r) => ({ hello: r.hello.state, steps: Object.keys(r.steps) }));
  await b.browser.send('Target.closeTarget', { targetId: page2.targetId });
  // ---- switching to local while a page is connected cuts it off
  await setSource('site');
  const long = await newTab(b.browser, 'http://localhost:18765/hold.html');
  await sleep(2500);
  await setSource('local');
  await sleep(1500);
  out.cutOff = await long.send('Runtime.evaluate', { expression: `JSON.stringify(window.__hold)`, returnByValue: true }).then((r) => JSON.parse(r.result.value));
  await setSource('site');
  out.siteAgain = { rules: await rules(), legacy: await go('https://s.kiwi.moe/s?q=back') };
} catch (e) { out.error = String(e && e.stack || e).slice(0, 500); } finally { await b.stop(); S.close(); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(JSON.stringify(out, null, 1)); process.exit(0);
