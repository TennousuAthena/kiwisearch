// With a production build (no development origin): which pages of kiwi.moe get the bridge's mark? Only the search page, the root.
// The host is mapped to a local HTTPS server that answers every path with a plain page.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { sleep, startServers, launchChromium, newTab } from './lib.mjs';
const build = process.argv[2];
const S = await startServers();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-p0-ext-')); fs.cpSync(build, dir, { recursive: true });
const b = await launchChromium({ ext: dir, httpsPort: S.httpsPort });
const out = {};
try {
  await sleep(2000);
  for (const url of ['https://kiwi.moe/', 'https://kiwi.moe/#q=x', 'https://kiwi.moe/install', 'https://kiwi.moe/en/about', 'https://s.kiwi.moe/']) {
    const tab = await newTab(b.browser, 'about:blank');
    await tab.send('Page.enable'); await tab.send('Page.navigate', { url }); await sleep(1500);
    out[url] = (await tab.send('Runtime.evaluate', { expression: 'JSON.stringify(document.documentElement.dataset.kiwi ?? null)', returnByValue: true })).result.value;
    await b.browser.send('Target.closeTarget', { targetId: tab.targetId });
  }
} finally { await b.stop(); S.close(); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(JSON.stringify(out, null, 1)); process.exit(0);
