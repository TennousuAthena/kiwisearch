// The website opens another page in the same tab, the user comes Back (the browser's back-forward cache brings the page back with its script state),
// and searches again. Checks that the link to the extension still works, and whether the page had to reload itself to recover (it does when the link is dead).
// Needs a dev-origin build of the extension (WXT_KIWI_WEB_DEV_ORIGIN=http://localhost:18765) and a build of apps/web.
// Usage: node bfcache-check.mjs <extension build> <apps/web/dist>
import fs from 'node:fs'; import http from 'node:http'; import os from 'node:os'; import path from 'node:path';
import { sleep, launchChromium, newTab, findExtension, evalIn } from './lib.mjs';
const [ext, dist] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname; if (p === '/') p = '/index.html'; if (!path.extname(p)) p += '.html';
  const f = path.join(dist, p); if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(18765, '127.0.0.1', r));
const tmpExt = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-p0-ext-')); fs.cpSync(ext, tmpExt, { recursive: true });
const b = await launchChromium({ ext: tmpExt, httpsPort: 1 });
const out = {};
try {
  const sw = await findExtension(b.browser); await sleep(1500);
  // What reaches the service worker: one `search` connection for every search that really starts.
  await evalIn(b.browser, sw.targetId, `self.__connects = []; chrome.runtime.onConnect.addListener((p) => self.__connects.push(p.name))`);
  const searches = async () => JSON.parse(await evalIn(b.browser, sw.targetId, 'JSON.stringify(self.__connects)')).filter((n) => n === 'search').length;
  const tab = await newTab(b.browser, 'about:blank'); await tab.send('Page.enable'); await tab.send('Runtime.enable');
  const ev = async (expression) => (await tab.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  await tab.send('Page.navigate', { url: 'http://localhost:18765/#q=first' }); await sleep(6500);
  // A marker that only survives while this very document lives: a reload takes it away.
  await ev(`window.__marker = 'same document'; addEventListener('pageshow', (e) => { window.__persisted = e.persisted; })`);
  out.searchesAfterFirst = await searches();
  await ev(`location.href = 'http://localhost:18765/about'`); await sleep(1500);
  await ev(`history.back()`); await sleep(2000);
  out.restoredFromCache = await ev(`window.__persisted === true`);
  await ev(`location.hash = '#q=second'`); await sleep(7500);
  out.pageReloadedItself = (await ev(`window.__marker ?? null`)) === null;
  out.searchesAfterSecond = await searches();
  out.secondSearchReachedTheExtension = out.searchesAfterSecond > out.searchesAfterFirst;
  out.secondSearchStillWaiting = await ev(`document.body.innerText.includes('正在搜索')`);
} catch (e) { out.error = String(e.stack ?? e).slice(0, 300); } finally { await b.stop(); server.close(); fs.rmSync(tmpExt, { recursive: true, force: true }); }
console.log(JSON.stringify(out, null, 1)); process.exit(0);
