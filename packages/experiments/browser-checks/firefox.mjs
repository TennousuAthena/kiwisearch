// Phase 0 scenarios in a throwaway headless Firefox, started through web-ext with a temporary profile.
// Usage: node firefox.mjs [war]   (add "war" to make app.html web-accessible)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, sleep, stats, startServers } from './lib.mjs';

const war = process.argv[2] === 'war';
const FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox';
const WEBEXT = path.join(ROOT, 'tools/node_modules/web-ext/bin/web-ext.js');
const S = await startServers();
const report = `http://localhost:${S.httpPort}/report`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-p0-ffext-'));
fs.cpSync(path.join(ROOT, 'ext'), dir, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
mf.background = { scripts: ['background.js', 'selftest.js'] };
mf.permissions = [...mf.permissions, 'tabs'];
mf.browser_specific_settings = { gecko: { id: 'phase0-probe@kiwi.test' } };
if (war) mf.web_accessible_resources = [{ resources: ['app.html'], matches: ['<all_urls>'] }];
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));
const st = path.join(dir, 'selftest.js');
fs.writeFileSync(st, fs.readFileSync(st, 'utf8').replace('__REPORT__', report));

const label = (s) => `ff-${s}-${Date.now()}`;
const runs = [['burst', 1500, 0], ['paced', 300, 10]].map(([mode, n, pace]) => ({ mode, n, pace, label: label(mode) }));
const startUrls = runs.map((r) => `http://localhost:${S.httpPort}/bridge.html?n=${r.n}&pace=${r.pace}&label=${r.label}`);

const child = spawn('node', [WEBEXT, 'run', '--source-dir', dir, '--target', 'firefox-desktop', '--firefox', FIREFOX, '--no-reload', '--no-input',
  ...startUrls.flatMap((u) => ['--start-url', u]), '--args=-headless'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const out = { war };
try {
  out.hello = await S.waitReport((r) => r.label === 'ff-hello', 40000).catch(() => null);
  out.selftestStarted = !!(await S.waitReport((r) => r.label === 'ff-selftest-start', 30000).catch(() => null));
  out.selftest = await S.waitReport((r) => r.label === 'ff-selftest', 90000).catch((e) => ({ error: String(e) }));
  out.bridge = {};
  for (const r of runs) {
    const rep = await S.waitReport((x) => x.label === r.label, 90000).catch((e) => ({ error: String(e) }));
    out.bridge[r.mode] = rep.error && !rep.lat ? rep : {
      events: rep.events, handshakeMs: rep.handshakeMs && +rep.handshakeMs.toFixed(2), firstEventMs: rep.firstEventMs && +rep.firstEventMs.toFixed(2),
      totalMs: rep.totalMs && +rep.totalMs.toFixed(1), perEventLatencyMs: rep.lat && stats(rep.lat), attrAtStart: rep.attrAtStart, welcome: rep.welcome, error: rep.error, lm: rep.lm, ua: rep.ua,
    };
  }
} finally {
  child.kill('SIGTERM');
  await sleep(1500);
  child.kill('SIGKILL');
  S.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
out.webextLogTail = log.split('\n').slice(-8).join('\n');
fs.writeFileSync(path.join(ROOT, `results-firefox${war ? '-war' : ''}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
