// Helpers for the browser checks: local servers, a throwaway headless Chromium, and a small CDP client.
// Every browser gets a fresh temporary profile and a random debugging port, and all outside DNS is refused. Never use these with your own profile.
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.dirname(new URL(import.meta.url).pathname);
/** The browser to test in: set CHROMIUM to the binary of a Chromium (the default is the macOS app). Never point this at your own browser profile. */
export const CHROMIUM = process.env.CHROMIUM ?? '/Applications/Chromium.app/Contents/MacOS/Chromium';

/** A self-signed certificate for `kiwi.moe`, made once; the test browsers ignore certificate errors. */
function ensureCertificate() {
  const key = path.join(ROOT, 'key.pem');
  const cert = path.join(ROOT, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=kiwi.moe'], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function stats(values) {
  const a = [...values].sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { n: a.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +a[a.length - 1].toFixed(2) };
}

export async function startServers({ httpPort = 0 } = {}) {
  const log = [];
  const reports = [];
  const waiters = [];
  const onReport = (r) => {
    reports.push(r);
    for (const w of [...waiters]) if (w.match(r)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(r); }
  };
  const waitReport = (match, ms = 60000) => new Promise((resolve, reject) => {
    const hit = reports.find(match);
    if (hit) return resolve(hit);
    const w = { match, resolve };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout waiting for report')); } }, ms);
  });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (url.pathname === '/report' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { try { onReport(JSON.parse(body)); } catch { /* ignore */ } res.writeHead(200, cors); res.end('ok'); });
      return;
    }
    log.push({ srv: 'http', host: req.headers.host, url: req.url });
    const file = { '/bridge.html': 'bridge.html', '/bridge-page.js': 'bridge-page.js', '/ext-smoke.html': 'ext-smoke.html', '/ext-smoke.js': 'ext-smoke.js', '/protocol.js': 'protocol.js', '/hold.html': 'hold.html' }[url.pathname];
    if (file) {
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html', ...cors });
      return res.end(fs.readFileSync(path.join(ROOT, 'web', file)));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>blank</body></html>');
  });
  await new Promise((r) => httpServer.listen(httpPort, '127.0.0.1', r));
  const httpsServer = https.createServer(ensureCertificate(), (req, res) => {
    log.push({ srv: 'https', host: req.headers.host, url: req.url });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>the website</body></html>');
  });
  await new Promise((r) => httpsServer.listen(0, '127.0.0.1', r));
  return {
    log, reports, waitReport,
    httpPort: httpServer.address().port,
    httpsPort: httpsServer.address().port,
    close: () => { httpServer.close(); httpsServer.close(); },
  };
}

export async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0;
  const pending = new Map();
  const handlers = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
    } else handlers.forEach((h) => h(m));
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, on: (h) => handlers.push(h), close: () => ws.close() };
}

/** A throwaway headless Chromium. All external DNS is refused; only the mapped test hosts and localhost resolve. */
export async function launchChromium({ ext, httpsPort, extraArgs = [], allowHosts = [] }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kiwi-p0-'));
  const rules = [
    `MAP kiwi.moe 127.0.0.1:${httpsPort}`, `MAP s.kiwi.moe 127.0.0.1:${httpsPort}`, `MAP u.kiwi.moe 127.0.0.1:${httpsPort}`,
    'MAP * ~NOTFOUND', 'EXCLUDE localhost', 'EXCLUDE 127.0.0.1', ...allowHosts.map((host) => `EXCLUDE ${host}`),
  ].join(', ');
  const args = [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--ignore-certificate-errors', `--host-resolver-rules=${rules}`,
    ...(ext ? [`--load-extension=${ext}`, `--disable-extensions-except=${ext}`] : []),
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(CHROMIUM, args, { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(150);
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  const browser = await cdp(`ws://127.0.0.1:${port}${wsPath}`);
  const stop = async () => {
    try { await browser.send('Browser.close'); } catch { /* already gone */ }
    await sleep(600);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(profile, { recursive: true, force: true });
  };
  return { browser, profile, stop, port: Number(port) };
}

export async function newTab(browser, url = 'about:blank') {
  const { targetId } = await browser.send('Target.createTarget', { url });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId, send: (m, p) => browser.send(m, p, sessionId) };
}

export async function targetInfo(browser, targetId) {
  const { targetInfos } = await browser.send('Target.getTargets');
  return targetInfos.find((t) => t.targetId === targetId);
}

export async function findExtension(browser, fileName = 'background.js') {
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://') && t.url.endsWith(fileName));
    if (sw) return { targetId: sw.targetId, id: new URL(sw.url).host };
    await sleep(250);
  }
  throw new Error('extension service worker did not start');
}

export async function evalIn(browser, targetId, expression, opts = {}) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const r = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...opts }, sessionId);
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300));
  return r.result.value;
}
