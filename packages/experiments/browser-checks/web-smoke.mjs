import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { sleep, startServers, launchChromium, newTab } from './lib.mjs';
const build = process.argv[2];
const S = await startServers({ httpPort: 18765 });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-p0-ext-')); fs.cpSync(build, dir, { recursive: true });
const b = await launchChromium({ ext: dir, httpsPort: S.httpsPort });
let out = {};
try {
  await sleep(2000);
  const a = await newTab(b.browser, 'http://localhost:18765/ext-smoke.html');
  out.localhost = await S.waitReport((r) => r.label === 'ext-smoke' && r.origin === 'http://localhost:18765', 90000);
  const c = await newTab(b.browser, 'http://127.0.0.1:18765/ext-smoke.html');
  out.other = await S.waitReport((r) => r.label === 'ext-smoke' && r.origin === 'http://127.0.0.1:18765', 30000);
} catch (e) { out.error = String(e); } finally { await b.stop(); S.close(); fs.rmSync(dir, { recursive: true, force: true }); }
console.log(JSON.stringify(out, null, 1));
process.exit(0);
