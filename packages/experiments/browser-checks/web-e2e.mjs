// The built website, served as Cloudflare would (its _headers applied), against the built extension, in a throwaway headless Chromium.
import fs from 'node:fs'; import http from 'node:http'; import os from 'node:os'; import path from 'node:path';
import { sleep, launchChromium, newTab } from './lib.mjs';
const [ext, dist, shots] = process.argv.slice(2);
const PORT = 18765;
const headerRules = []; { let cur = null; for (const line of fs.readFileSync(path.join(dist, '_headers'), 'utf8').split('\n')) { if (!line.trim() || line.startsWith('#')) continue; if (!/^\s/.test(line)) { cur = { path: line.trim(), headers: {} }; headerRules.push(cur); } else { const i = line.indexOf(':'); cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); } } }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain' };
const requests = [];
let serverUp = true;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); requests.push(url.pathname);
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(dist, path.normalize(file));
  if (!full.startsWith(dist) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('nope'); }
  const headers = { 'content-type': types[path.extname(full)] ?? 'application/octet-stream' };
  for (const rule of headerRules) { const m = rule.path.endsWith('*') ? url.pathname.startsWith(rule.path.slice(0, -1)) : rule.path === url.pathname; if (m) Object.assign(headers, rule.headers); }
  res.writeHead(200, headers); res.end(fs.readFileSync(full));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const out = {}; const violations = [];
const tmpExt = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-p0-ext-')); fs.cpSync(ext, tmpExt, { recursive: true });
async function page(browser, url, wait = 3000) {
  const tab = await newTab(browser, 'about:blank');
  await tab.send('Runtime.enable'); await tab.send('Log.enable'); await tab.send('Page.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  const errors = [];
  browser.on((m) => { if (m.sessionId !== tab.sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.slice(0, 200) ?? m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(m.params.entry.text + (m.params.entry.url ?? ''))) errors.push((m.params.entry.source + ': ' + m.params.entry.text).slice(0, 220)); });
  await tab.send('Page.navigate', { url }); await sleep(wait);
  const ev = async (expression) => (await tab.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const shot = async (name) => fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from((await tab.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  return { tab, ev, shot, errors };
}
let b = await launchChromium({ ext: tmpExt, httpsPort: 1 });
try {
  await sleep(2000);
  // 1. a search from the address, with the extension
  const a = await page(b.browser, `http://localhost:${PORT}/#q=${encodeURIComponent('hello world')}`, 7000);
  out.withExtension = await a.ev(`JSON.stringify({ title: document.title, input: document.querySelector('input')?.value, hasSearchbox: !!document.querySelector('.searchbox'), text: document.body.innerText.slice(0, 160), hash: location.hash, theme: document.documentElement.dataset.theme })`).then(JSON.parse);
  out.withExtension.errors = a.errors;
  await a.shot('site-search');
  // 2. the user types a new address in this tab: a fragment navigation (Chromium leaves & unescaped)
  await a.ev(`location.hash = '#q=a&b=c%20d'`); await sleep(4500);
  out.fragmentNavigation = await a.ev(`JSON.stringify({ input: document.querySelector('input')?.value, title: document.title, expiredNotice: /过期|expired/.test(document.body.innerText), text: document.body.innerText.slice(0, 120) })`).then(JSON.parse);
  // 3. the service worker has the shell now; take the server down and load the page again
  out.serviceWorker = await a.ev(`navigator.serviceWorker.getRegistration().then(r => JSON.stringify({ active: !!r?.active, scope: r?.scope }))`).then(JSON.parse);
  const keys = await a.ev(`caches.keys().then(k => JSON.stringify(k))`); out.cacheNames = JSON.parse(keys);
  serverUp = false; server.close(); server.closeAllConnections?.();
  const offline = await page(b.browser, `http://localhost:${PORT}/#q=offline%20test`, 4000);
  out.siteDown = await offline.ev(`JSON.stringify({ hasSearchbox: !!document.querySelector('.searchbox'), input: document.querySelector('input')?.value, text: document.body.innerText.slice(0, 80) })`).then(JSON.parse);
  out.siteDown.errors = offline.errors;
  await offline.shot('site-down');
} catch (e) { out.error = String(e && e.stack || e).slice(0, 400); } finally { await b.stop(); }
// 4. no extension at all
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
b = await launchChromium({ ext: null, httpsPort: 1 });
try {
  await sleep(1500);
  const m = await page(b.browser, `http://localhost:${PORT}/#m=news&q=${encodeURIComponent('a&b c')}`, 2500);
  out.noExtension = await m.ev(`JSON.stringify({ title: document.querySelector('h1')?.textContent, input: document.querySelector('input')?.value, links: [...document.querySelectorAll('.panel-engines a')].map(a => a.href), install: document.querySelector('a.btn.primary')?.href })`).then(JSON.parse);
  out.noExtension.errors = m.errors;
  await m.shot('site-missing');
  // remembered engine: goes straight to it, without a click
  await m.ev(`localStorage.setItem('kiwi:fallbackEngine', 'duckduckgo')`);
  const r = await page(b.browser, `http://localhost:${PORT}/#q=remember%20me`, 2000);
  out.remembered = await r.ev(`location.href`).catch(() => 'navigated away');
  const info = await b.browser.send('Target.getTargets'); out.rememberedTargets = info.targetInfos.filter((t) => t.type === 'page').map((t) => t.url).filter((u) => /duckduckgo/.test(u));
} catch (e) { out.error2 = String(e && e.stack || e).slice(0, 400); } finally { await b.stop(); server.close(); fs.rmSync(tmpExt, { recursive: true, force: true }); }
out.requestsSeen = [...new Set(requests)].slice(0, 12);
console.log(JSON.stringify(out, null, 1)); process.exit(0);
