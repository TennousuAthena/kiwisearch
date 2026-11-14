import fs from 'node:fs'; import http from 'node:http'; import path from 'node:path';
import { sleep, launchChromium, newTab } from './lib.mjs';
const [dist, shots] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain' };
// The policy of the plain pages (the rule for /about in _headers).
const csp = fs.readFileSync(path.join(dist, '_headers'), 'utf8').match(/\/about\n\s+Content-Security-Policy: (.*)/)[1];
const server = http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname; if (!path.extname(p)) p += '.html';
  const f = path.join(dist, p); if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream', 'content-security-policy': csp }); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(18770, '127.0.0.1', r));
const b = await launchChromium({ ext: null, httpsPort: 1 });
const out = {};
try {
  for (const [name, url, w, h] of [['about', '/about', 1100, 800], ['start', '/start', 1100, 1100], ['privacy', '/privacy', 1100, 1400], ['en-about', '/en/about', 1100, 700], ['about-mobile', '/about', 390, 800]]) {
    const tab = await newTab(b.browser, 'about:blank'); await tab.send('Runtime.enable'); await tab.send('Log.enable'); await tab.send('Page.enable');
    const errors = []; b.browser.on((m) => { if (m.sessionId === tab.sessionId && m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text.slice(0, 160)); });
    await tab.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
    await tab.send('Page.navigate', { url: `http://localhost:18770${url}` }); await sleep(900);
    out[name] = { errors, title: (await tab.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value, overflowX: (await tab.send('Runtime.evaluate', { expression: 'document.documentElement.scrollWidth > innerWidth', returnByValue: true })).result.value };
    fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from((await tab.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  }
} finally { await b.stop(); server.close(); }
console.log(JSON.stringify(out, null, 1)); process.exit(0);
