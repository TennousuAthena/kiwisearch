// Smoke test of a built extension in a throwaway headless Chromium. External DNS is refused, so nothing reaches a search engine.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { sleep, startServers, launchChromium, newTab, findExtension } from './lib.mjs';
const build = process.argv[2]; const outDir = process.argv[3]; const query = process.argv[4] ?? 'hello world';
const S = await startServers();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-p0-ext-')); fs.cpSync(build, dir, { recursive: true });
const b = await launchChromium({ ext: dir, httpsPort: S.httpsPort });
const result = {};
try {
  const ext = await findExtension(b.browser, 'background.js');
  await sleep(1500);
  const errors = [];
  const visit = async (name, url, wait, viewport) => {
    const tab = await newTab(b.browser, 'about:blank');
    await tab.send('Runtime.enable'); await tab.send('Log.enable'); await tab.send('Page.enable');
    await tab.send('Emulation.setDeviceMetricsOverride', { width: viewport?.[0] ?? 1100, height: viewport?.[1] ?? 800, deviceScaleFactor: 1, mobile: false });
    b.browser.on((m) => { if (m.sessionId !== tab.sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') errors.push({ page: name, text: m.params.exceptionDetails.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails.text });
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push({ page: name, text: m.params.entry.text.slice(0, 200) + ' ' + (m.params.entry.url ?? '') });
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push({ page: name, text: JSON.stringify(m.params.args.map((a) => a.value ?? a.description)).slice(0, 300) }); });
    await tab.send('Page.navigate', { url });
    await sleep(wait);
    const info = await tab.send('Runtime.evaluate', { expression: `JSON.stringify({ title: document.title, lang: document.documentElement.lang, theme: document.documentElement.dataset.theme, inputs: document.querySelectorAll('input').length, buttons: document.querySelectorAll('button').length, text: document.body.innerText.slice(0, 400) })`, returnByValue: true });
    result[name] = JSON.parse(info.result.value);
    const shot = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(shot.data, 'base64'));
    await b.browser.send('Target.closeTarget', { targetId: tab.targetId });
  };
  await visit('home', `chrome-extension://${ext.id}/app.html`, 2500);
  await visit('search', `chrome-extension://${ext.id}/app.html?q=${encodeURIComponent(query)}`, 9000);
  await visit('options', `chrome-extension://${ext.id}/options.html`, 2500, [1100, 900]);
  result.errors = errors;
} finally { await b.stop(); S.close(); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(JSON.stringify(result, null, 1));
process.exit(0);
