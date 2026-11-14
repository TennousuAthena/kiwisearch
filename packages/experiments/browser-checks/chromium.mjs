// Phase 0 scenarios in throwaway headless Chromium 156. Usage: node chromium.mjs <dnr|bridge|optional|dse|all>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sleep, stats, startServers, launchChromium, newTab, targetInfo, findExtension, evalIn } from './lib.mjs';

const which = process.argv[2] ?? 'all';
const S = await startServers();
const out = {};
const hitsSince = (mark) => S.log.slice(mark).filter((e) => e.srv === 'https').map((e) => `${e.host}${e.url}`);

function copyExt(name, patch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kiwi-p0-ext-`));
  fs.cpSync(path.join(ROOT, name), dir, { recursive: true });
  if (patch) {
    const file = path.join(dir, 'manifest.json');
    const mf = JSON.parse(fs.readFileSync(file, 'utf8'));
    patch(mf);
    fs.writeFileSync(file, JSON.stringify(mf, null, 2));
  }
  return dir;
}

async function browserNav(browser, url) {
  const tab = await newTab(browser);
  await tab.send('Page.enable');
  const mark = S.log.length;
  const r = await tab.send('Page.navigate', { url });
  await sleep(1800);
  const info = await targetInfo(browser, tab.targetId);
  await browser.send('Target.closeTarget', { targetId: tab.targetId });
  return { final: info?.url, navError: r.errorText ?? null, serverHits: hitsSince(mark) };
}

async function rendererNav(browser, url) {
  const tab = await newTab(browser, `http://localhost:${S.httpPort}/blank`);
  await sleep(700);
  const mark = S.log.length;
  await tab.send('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(url)}` });
  await sleep(1800);
  const info = await targetInfo(browser, tab.targetId);
  await browser.send('Target.closeTarget', { targetId: tab.targetId });
  return { final: info?.url, serverHits: hitsSince(mark) };
}

async function dnrAndBridge(war) {
  const dir = copyExt('ext', (mf) => { if (war) mf.web_accessible_resources = [{ resources: ['app.html'], matches: ['<all_urls>'] }]; });
  const b = await launchChromium({ ext: dir, httpsPort: S.httpsPort });
  const res = { war };
  try {
    const ext = await findExtension(b.browser);
    await sleep(1500);
    res.extId = ext.id.slice(0, 6) + '…';
    res.rules = await evalIn(b.browser, ext.targetId, '(async()=>JSON.stringify({n:(await chrome.declarativeNetRequest.getDynamicRules()).length, err:self.__ruleError??null}))()');

    const cases = [
      ['browser', 'https://s.kiwi.moe/s?q=hello%20world'],
      ['renderer', 'https://s.kiwi.moe/s?q=hello%20world'],
      ['browser', 'https://s.kiwi.moe/#q=hello%20world'],
      ['browser', 'https://u.kiwi.moe/#q=hello%20world'],
      ['browser', 'https://local.kiwi.invalid/s?q=abc'],
      ['renderer', 'https://local.kiwi.invalid/s?q=abc'],
      ['browser', 'https://nope.kiwi.invalid/#q=hello'],
    ];
    res.dnr = [];
    for (const [kind, url] of cases) {
      const r = kind === 'browser' ? await browserNav(b.browser, url) : await rendererNav(b.browser, url);
      res.dnr.push({ kind, url, ...r });
    }
    res.webNavigation = JSON.parse(await evalIn(b.browser, ext.targetId, 'JSON.stringify({nav:self.__nav,errors:self.__errors})'));

    if (!war) {
      res.bridge = {};
      const report = `http://localhost:${S.httpPort}/report`;
      const runs = [['burst', 1500, 0], ['paced', 300, 10]];
      for (const [mode, n, pace] of runs) {
        for (const path of ['direct', 'bridge']) {
          const samples = [];
          for (let rep = 0; rep < 3; rep++) {
            const label = `${path}-${mode}-${rep}-${Date.now()}`;
            const url = path === 'direct'
              ? `chrome-extension://${ext.id}/app.html?run=direct&n=${n}&pace=${pace}&label=${label}&report=${encodeURIComponent(report)}`
              : `http://localhost:${S.httpPort}/bridge.html?n=${n}&pace=${pace}&label=${label}`;
            const tab = await newTab(b.browser, url);
            const r = await S.waitReport((x) => x.label === label, 40000);
            await b.browser.send('Target.closeTarget', { targetId: tab.targetId });
            samples.push(r);
          }
          const lat = samples.flatMap((s) => s.lat ?? []);
          res.bridge[`${path}/${mode}`] = {
            events: samples[0].events, resultsBytes: samples[0].resultsBytes,
            handshakeMs: path === 'bridge' ? samples.map((s) => +s.handshakeMs.toFixed(2)) : undefined,
            firstEventMs: samples.map((s) => +s.firstEventMs.toFixed(2)),
            totalMs: samples.map((s) => +s.totalMs.toFixed(1)),
            perEventLatencyMs: stats(lat),
            attrAtStart: samples[0].attrAtStart, attrNow: samples[0].attrNow, welcome: samples[0].welcome, error: samples[0].error,
            languageModel: samples[0].lm, ua: samples[0].ua,
          };
        }
      }
    }
  } finally { await b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  return res;
}

async function optionalPermission() {
  const dir = copyExt('ext-optional');
  const b = await launchChromium({ ext: dir, httpsPort: S.httpsPort });
  const res = {};
  try {
    const ext = await findExtension(b.browser);
    await sleep(800);
    const ext0 = await newTab(b.browser, 'chrome://extensions');
    await sleep(1200);
    const info = await ext0.send('Runtime.evaluate', {
      expression: `chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}).then(l=>JSON.stringify(l.filter(e=>e.id==='${ext.id}').map(e=>({name:e.name,installWarnings:e.installWarnings,manifestErrors:e.manifestErrors,optional:e.permissions?.simplePermissions}))))`,
      awaitPromise: true, returnByValue: true,
    });
    res.developerPrivate = info.result?.value ?? info.exceptionDetails?.text;
    res.manifestOptional = await evalIn(b.browser, ext.targetId, 'JSON.stringify({manifest: chrome.runtime.getManifest().optional_permissions, all: null})');
    res.getAll = await evalIn(b.browser, ext.targetId, 'chrome.permissions.getAll().then(JSON.stringify)');
    const page = await newTab(b.browser, `chrome-extension://${ext.id}/page.html`);
    await sleep(600);
    const p = await page.send('Runtime.evaluate', {
      expression: `Promise.race([chrome.permissions.request({permissions:['webNavigation']}).then(r=>'granted='+r, e=>'ERR:'+e.message), new Promise(r=>setTimeout(()=>r('NO ANSWER in 8s (a prompt cannot be answered headlessly)'),8000))])`,
      awaitPromise: true, returnByValue: true, userGesture: true,
    });
    res.request = p.result?.value ?? p.exceptionDetails?.exception?.description;
  } finally { await b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  return res;
}

async function defaultSearch() {
  const dir = copyExt('ext-dse');
  const b = await launchChromium({ ext: dir, httpsPort: S.httpsPort });
  const res = {};
  try {
    const ext = await findExtension(b.browser);
    await sleep(2500);
    const mark = S.log.length;
    const before = (await b.browser.send('Target.getTargets')).targetInfos.map((t) => t.targetId);
    const text = 'hello world&x=1#f 你好';
    res.queryResult = await evalIn(b.browser, ext.targetId, `chrome.search.query({text:${JSON.stringify(text)},disposition:'NEW_TAB'}).then(()=>'ok',e=>'ERR:'+e.message)`);
    await sleep(2500);
    const after = (await b.browser.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page' && !before.includes(t.targetId));
    res.newTabs = after.map((t) => t.url);
    res.serverHits = hitsSince(mark);
  } finally { await b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  return res;
}

try {
  if (which === 'dnr' || which === 'bridge' || which === 'all') out.war_off = await dnrAndBridge(false);
  if (which === 'dnr' || which === 'all') out.war_on = await dnrAndBridge(true);
  if (which === 'optional' || which === 'all') out.optional = await optionalPermission();
  if (which === 'dse' || which === 'all') out.dse = await defaultSearch();
} finally { S.close(); }
fs.writeFileSync(path.join(ROOT, `results-chromium-${which}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
