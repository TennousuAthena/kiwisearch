// Layering of the engine marks and the search suggestions: the dropdown under the search box must be above a result's engine marks that sit behind it.
// Renders the built style sheets of apps/web with a search box whose suggestions are open and, below, a result with a stack of three marks, then asks the
// browser which element is on top at the centre of each mark. Usage: node layering-check.mjs <apps/web/dist> [label] [screenshot-dir]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { sleep, launchChromium, newTab } from './lib.mjs';
const [dist, label = 'check', shots = os.tmpdir()] = process.argv.slice(2);
const assets = path.resolve(dist, 'assets');
const css = fs.readdirSync(assets).filter((f) => /^(base|index)-.*\.css$/.test(f)).map((f) => `<link rel="stylesheet" href="file://${path.join(assets, f)}">`).join('');
const marks = [0, 1, 2].map((i) => `<span class="src-mark" style="--i:${i}"></span>`).join('');
const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">${css}</head><body><div class="page">
<header class="topbar"><div class="brand"><a href="#">Kiwi</a></div>
<form class="searchbox has-suggestions" role="search"><input value=""><button type="submit" class="searchbox-btn searchbox-submit"></button>
<div class="search-suggestions"><div class="suggestions-caption"><span>recent</span><span>local</span></div><ul><li>one</li><li>two</li></ul><button type="button" class="clear-recent">clear</button></div></form></header>
<main class="content"><div class="results"><article class="result"><span class="site-line"><span class="site-name">example.com</span><span class="src-marks">${marks}</span></span><h3><a href="#">A result</a></h3><p>text</p></article></div></main></div></body></html>`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-layer-')); const file = path.join(dir, 'page.html'); fs.writeFileSync(file, html);
const b = await launchChromium({ ext: null, httpsPort: 1 });
const out = { label };
try {
  const tab = await newTab(b.browser, 'about:blank'); await tab.send('Page.enable'); await tab.send('Runtime.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 640, deviceScaleFactor: 1, mobile: false });
  await tab.send('Page.navigate', { url: `file://${file}` }); await sleep(1200);
  // Put the marks well inside the dropdown's box (30px above its bottom edge), as in the report. Where a result starts below the search box depends on the tabs and status lines, so the page is moved to make them overlap.
  await tab.send('Runtime.evaluate', { expression: `(() => { const box = document.querySelector('.search-suggestions').getBoundingClientRect(); const m = document.querySelector('.src-mark').getBoundingClientRect();
    document.querySelector('main').style.marginTop = (box.bottom - 30 - (m.y + m.height / 2)) + 'px'; })()` });
  await sleep(200);
  const r = JSON.parse((await tab.send('Runtime.evaluate', { returnByValue: true, expression: `JSON.stringify((() => {
    const box = document.querySelector('.search-suggestions').getBoundingClientRect();
    const kind = (el) => el?.closest('.search-suggestions') ? 'dropdown' : el?.closest('.src-mark') ? 'mark' : (el?.tagName ?? 'none');
    const marks = [...document.querySelectorAll('.src-mark')].map((m) => { const q = m.getBoundingClientRect(); const x = q.x + q.width / 2; const y = q.y + q.height / 2;
      return { insideDropdownBox: x >= box.left && x <= box.right && y >= box.top && y <= box.bottom, onTop: kind(document.elementFromPoint(x, y)) }; });
    return { dropdownBottom: Math.round(box.bottom), marks };
  })())` })).result.value);
  out.stylesLoaded = JSON.parse((await tab.send('Runtime.evaluate', { returnByValue: true, expression: `JSON.stringify(getComputedStyle(document.querySelector('.search-suggestions')).position === 'absolute')` })).result.value);
  Object.assign(out, r);
  out.harnessMeaningful = r.marks.every((m) => m.insideDropdownBox);
  out.marksOverDropdown = r.marks.filter((m) => m.onTop === 'mark').length;
  fs.writeFileSync(path.join(shots, `layering-${label}.png`), Buffer.from((await tab.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  // The stack itself is unchanged: moved out from under the dropdown, where two marks overlap the best-ranked (--i 0) is the one on top.
  await tab.send('Runtime.evaluate', { expression: `document.querySelector('main').style.marginTop = '300px'` }); await sleep(200);
  out.stackOrder = JSON.parse((await tab.send('Runtime.evaluate', { returnByValue: true, expression: `JSON.stringify((() => {
    const [a, b] = [...document.querySelectorAll('.src-mark')].map((m) => m.getBoundingClientRect());
    const x = (b.left + a.right) / 2; const y = a.y + a.height / 2;
    return { overlapPointOnTop: document.elementFromPoint(x, y)?.closest('.src-mark')?.style.getPropertyValue('--i') ?? null };
  })())` })).result.value);
  out.bestRankedOnTop = out.stackOrder.overlapPointOnTop === '0';
  out.pass = out.stylesLoaded && out.harnessMeaningful && out.marksOverDropdown === 0 && out.bestRankedOnTop;
} finally { await b.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(JSON.stringify(out, null, 1)); process.exit(out.pass ? 0 : 1);
