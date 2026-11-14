// The website as Cloudflare serves it (a preview deployment or kiwi.moe), in a throwaway headless Chromium with no extension: only the one
// host named on the command line resolves. Checks the service worker over https, the cache, console errors (security policy) and the no-extension screen.
import fs from 'node:fs';
import { sleep, startServers, launchChromium, newTab } from './lib.mjs';
const [url, shots = '/tmp'] = process.argv.slice(2);
const host = new URL(url).hostname;
const S = await startServers();
const b = await launchChromium({ ext: null, httpsPort: S.httpsPort, allowHosts: [host] });
const out = {};
try {
  const tab = await newTab(b.browser, 'about:blank');
  await tab.send('Runtime.enable'); await tab.send('Log.enable'); await tab.send('Page.enable');
  const errors = [];
  b.browser.on((m) => { if (m.sessionId === tab.sessionId && m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push((m.params.entry.source + ': ' + m.params.entry.text).slice(0, 200)); });
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  await tab.send('Page.navigate', { url }); await sleep(Number(process.env.WAIT_MS ?? 4000));
  const ev = async (expression) => (await tab.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  out.page = JSON.parse(await ev(`JSON.stringify({ title: document.querySelector('h1')?.textContent, panel: !!document.querySelector('.panel'), install: document.querySelector('a.btn.primary')?.getAttribute('href') })`));
  out.serviceWorker = JSON.parse(await ev(`navigator.serviceWorker.getRegistration().then(r => JSON.stringify({ active: !!r?.active, installing: r?.installing?.state ?? null, waiting: r?.waiting?.state ?? null, scope: r?.scope }))`));
  out.cacheFiles = JSON.parse(await ev(`caches.keys().then(async (keys) => JSON.stringify(await Promise.all(keys.map(async (k) => [k, (await (await caches.open(k)).keys()).length]))))`));
  out.errors = errors;
  fs.writeFileSync(`${shots}/preview.png`, Buffer.from((await tab.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
} finally { await b.stop(); S.close(); }
console.log(JSON.stringify(out, null, 1)); process.exit(0);
