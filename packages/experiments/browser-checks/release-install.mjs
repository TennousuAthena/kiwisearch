// Built website under its real CSP, with the installed Chromium and a disposable headless profile.
// External DNS is refused. Release redirects and asset downloads are checked separately.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launchChromium, newTab, sleep } from './lib.mjs';

const [distArg, shots] = process.argv.slice(2);
assert(distArg && shots, 'Usage: node release-install.mjs <apps/web/dist> <evidence-dir>');
const dist = path.resolve(distArg);
fs.mkdirSync(shots, { recursive: true });
const policies = new Map();
let route;
for (const line of fs.readFileSync(path.join(dist, '_headers'), 'utf8').split(/\r?\n/)) {
  if (line.startsWith('/')) route = line.trim();
  const policy = line.match(/^  Content-Security-Policy: (.+)$/);
  if (policy) policies.set(route, policy[1]);
}
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.join(dist, pathname === '/' ? 'index.html' : path.extname(pathname) ? pathname : pathname + '.html');
  if (!file.startsWith(dist + '/') || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)] ?? 'application/octet-stream';
  const policy = policies.get(pathname) ?? (pathname.startsWith('/en/') ? policies.get('/en/*') : null);
  res.writeHead(200, { 'content-type': type, ...(policy ? { 'content-security-policy': policy } : {}) });
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://localhost:' + server.address().port;
const report = { checks: [] };
const releases = 'https://github.com/TennousuAthena/kiwisearch/releases';
const latest = releases + '/latest';
let browser;
try {
  browser = await launchChromium({ ext: null, httpsPort: 1 });
  report.browser = await browser.browser.send('Browser.getVersion');
  const tab = await newTab(browser.browser);
  for (const domain of ['Runtime', 'Log', 'Network', 'Page']) await tab.send(domain + '.enable');
  const errors = [], externalRequests = [];
  browser.browser.on((m) => {
    if (m.sessionId !== tab.sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    if (m.method === 'Network.requestWillBeSent' && /^https?:/.test(m.params.request.url) && new URL(m.params.request.url).origin !== base) externalRequests.push(m.params.request.url);
  });
  const evaluate = async (expression) => {
    const result = await tab.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  for (const width of [1440, 390, 320]) {
    for (const theme of ['light', 'dark']) {
      await tab.send('Emulation.setDeviceMetricsOverride', { width, height: width > 500 ? 1000 : 1100, deviceScaleFactor: 1, mobile: width < 500 });
      await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
      for (const page of ['/', '/install', '/en/install']) {
        await tab.send('Page.navigate', { url: base + page });
        for (let attempt = 0; attempt < 30; attempt++) {
          if (await evaluate('!!document.querySelector(' + JSON.stringify('a[href="' + latest + '"]') + ')')) break;
          await sleep(200);
        }
        const links = await evaluate('Array.from(document.querySelectorAll("a"), a => a.href)');
        const overflow = await evaluate('document.documentElement.scrollWidth > innerWidth');
        assert(links.includes(latest) && links.includes(releases), 'Release links missing: ' + page);
        assert(!overflow, 'Horizontal overflow: ' + [page, width, theme].join(' '));
        assert(!/安装包.*尚未发布|release packages have not been published/.test(await evaluate('document.body.innerText')));
        if (page === '/') {
          assert.equal(await evaluate('document.documentElement.dataset.theme'), theme);
          for (const [choice, suffix] of [['chrome', 'chrome-mv3.zip'], ['chromium', 'chrome-mv3.zip'], ['brave', 'chrome-mv3.zip'], ['opera', 'chrome-mv3.zip'], ['edge', 'edge-mv3.zip'], ['firefox', 'firefox-mv2.zip']]) {
            await evaluate('{ const select = document.querySelector("select"); select.value = ' + JSON.stringify(choice) + '; select.dispatchEvent(new Event("change", { bubbles: true })); }');
            await sleep(30);
            assert((await evaluate('document.querySelector(".install-release").innerText')).includes(suffix));
          }
          await evaluate('{ const select = document.querySelector("select"); select.value = "chromium"; select.dispatchEvent(new Event("change", { bubbles: true })); }');
          await sleep(30);
        }
        report.checks.push({ page, width, theme, overflow });
        const name = (page === '/' ? 'home' : page.slice(1).replaceAll('/', '-')) + '-' + width + '-' + theme + '.png';
        fs.writeFileSync(path.join(shots, name), Buffer.from((await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
      }
    }
  }
  assert.deepEqual(errors, [], 'Browser console / CSP errors');
  assert.deepEqual(externalRequests, [], 'External requests before user navigation');
  Object.assign(report, { errors, externalRequests, passed: true });
} finally {
  if (browser) await browser.stop();
  server.close();
  fs.writeFileSync(path.join(shots, 'results.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ browser: report.browser.product, checks: report.checks.length, passed: report.passed }));
