// The relay running in Cloudflare's own runtime (workerd), started locally by wrangler's test harness; nothing is deployed.
// Clients are plain WebSockets, as the devices' are.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const server = createTestHarness({ root: ROOT, workers: [{ configPath: './wrangler.jsonc' }] });
let base: URL;

const LIMITS = { frameBytes: 16_384, socketsPerTopic: 8, framesPerWindow: 100 };

beforeAll(async () => {
  base = (await server.listen()).url;
}, 120_000);

afterAll(async () => {
  await server.close();
});

const topic = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Client {
  ws: WebSocket;
  frames: Uint8Array[];
  texts: string[];
  closed: Promise<number>;
  nextFrame(ms?: number): Promise<Uint8Array>;
}

function connect(id: string): Promise<Client> {
  const ws = new WebSocket(new URL(`/v1/${id}`, base).href.replace(/^http/, 'ws'));
  ws.binaryType = 'arraybuffer';
  const frames: Uint8Array[] = [];
  const texts: string[] = [];
  const waiting: ((frame: Uint8Array) => void)[] = [];
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') return void texts.push(event.data);
    const frame = new Uint8Array(event.data as ArrayBuffer);
    frames.push(frame);
    waiting.shift()?.(frame);
  };
  const closed = new Promise<number>((resolve) => { ws.onclose = (event) => resolve(event.code); });
  const nextFrame = (ms = 3000) => new Promise<Uint8Array>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no frame arrived')), ms);
    waiting.push((frame) => { clearTimeout(timer); resolve(frame); });
  });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, frames, texts, closed, nextFrame });
    ws.onerror = () => reject(new Error('could not connect'));
  });
}

const upgrade = (path: string, headers: Record<string, string> = {}) =>
  server.fetch(new URL(path, base), { headers: { Upgrade: 'websocket', ...headers } });

describe('routes', () => {
  it('answers the health check with the protocol and limits, uncached', async () => {
    const res = await server.fetch(new URL('/v1/health', base));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ service: 'kiwi-sync-relay', protocol: 1, limits: { ...LIMITS, windowMs: 10_000 } });
  });

  it('refuses unknown paths, malformed topics and plain requests to a topic', async () => {
    expect((await server.fetch(new URL('/', base))).status).toBe(404);
    expect((await upgrade('/v1/short')).status).toBe(404);
    expect((await upgrade(`/v1/${topic()}.x`)).status).toBe(404);
    expect((await server.fetch(new URL(`/v1/${topic()}`, base))).status).toBe(426);
    expect((await server.fetch(new URL('/v1/health', base), { method: 'POST' })).status).toBe(405);
  });

  it('refuses web pages, the Kiwi website included, and accepts extension pages', async () => {
    expect((await upgrade(`/v1/${topic()}`, { Origin: 'https://kiwi.moe' })).status).toBe(403);
    expect((await upgrade(`/v1/${topic()}`, { Origin: 'http://localhost:8080' })).status).toBe(403);
    for (const origin of ['chrome-extension://abcdefghijklmnop', 'moz-extension://0d1e2f3a-1111-2222-3333-444455556666']) {
      const res = await upgrade(`/v1/${topic()}`, { Origin: origin });
      expect(res.status).toBe(101);
      res.webSocket?.accept();
      res.webSocket?.close(1000);
    }
  });
});

describe('forwarding', () => {
  it('forwards a binary frame unchanged to the other sockets of the topic, not back to the sender or to other topics', async () => {
    const id = topic();
    const a = await connect(id);
    const b = await connect(id);
    const c = await connect(id);
    const elsewhere = await connect(topic());
    const frame = crypto.getRandomValues(new Uint8Array(1564));
    const atB = b.nextFrame();
    const atC = c.nextFrame();
    a.ws.send(frame);
    expect(await atB).toEqual(frame);
    expect(await atC).toEqual(frame);
    await sleep(200);
    expect(a.frames).toHaveLength(0);
    expect(elsewhere.frames).toHaveLength(0);
    for (const client of [a, b, c, elsewhere]) client.ws.close(1000);
  });

  it('keeps nothing: a device that connects later receives none of the earlier frames', async () => {
    const id = topic();
    const a = await connect(id);
    const b = await connect(id);
    const atB = b.nextFrame();
    a.ws.send(bytes(100, 1));
    await atB;
    a.ws.close(1000);
    b.ws.close(1000);
    await Promise.all([a.closed, b.closed]);
    const late = await connect(id);
    const alone = await connect(topic());
    alone.ws.send(bytes(100, 2));
    await sleep(500);
    expect(late.frames).toHaveLength(0);
    late.ws.close(1000);
    alone.ws.close(1000);
  });

  it('answers a text ping with pong and keeps the socket open', async () => {
    const a = await connect(topic());
    a.ws.send('ping');
    await sleep(300);
    expect(a.texts).toEqual(['pong']);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    a.ws.close(1000);
  });

  it('keeps forwarding after the object is evicted from memory with its sockets hibernated', async () => {
    const id = topic();
    const a = await connect(id);
    const b = await connect(id);
    await server.getWorker().evictDurableObject('TOPIC', { name: id, webSockets: 'hibernate' });
    const frame = crypto.getRandomValues(new Uint8Array(64));
    const atB = b.nextFrame();
    a.ws.send(frame);
    expect(await atB).toEqual(frame);
    a.ws.close(1000);
    b.ws.close(1000);
  });
});

describe('limits', () => {
  it('closes a socket that sends text other than ping', async () => {
    const a = await connect(topic());
    a.ws.send('hello');
    expect(await a.closed).toBe(1003);
  });

  it(`closes a socket that sends a frame over ${LIMITS.frameBytes} bytes, and accepts one of exactly that size`, async () => {
    const id = topic();
    const a = await connect(id);
    const b = await connect(id);
    const atB = b.nextFrame();
    a.ws.send(bytes(LIMITS.frameBytes));
    expect((await atB).byteLength).toBe(LIMITS.frameBytes);
    a.ws.send(bytes(LIMITS.frameBytes + 1));
    expect(await a.closed).toBe(1009);
    b.ws.close(1000);
  });

  it(`closes a socket that sends more than ${LIMITS.framesPerWindow} frames in the window`, async () => {
    const a = await connect(topic());
    for (let i = 0; i <= LIMITS.framesPerWindow; i++) a.ws.send(bytes(16));
    expect(await a.closed).toBe(1008);
  });

  it(`takes at most ${LIMITS.socketsPerTopic} sockets in one topic`, async () => {
    const id = topic();
    const clients = await Promise.all(Array.from({ length: LIMITS.socketsPerTopic }, () => connect(id)));
    expect((await upgrade(`/v1/${id}`)).status).toBe(429);
    for (const client of clients) client.ws.close(1000);
  });
});

describe('what the relay keeps and says', () => {
  it('writes nothing to the logs while forwarding', async () => {
    server.clearLogs();
    const id = topic();
    const a = await connect(id);
    const b = await connect(id);
    const atB = b.nextFrame();
    a.ws.send(new TextEncoder().encode('kiwi-marker-frame'));
    await atB;
    a.ws.close(1000);
    b.ws.close(1000);
    await sleep(300);
    const logs = server.getLogs().map((entry) => JSON.stringify(entry));
    expect(logs.filter((line) => line.includes('kiwi-marker'))).toEqual([]);
    expect(logs.filter((line) => /"level":"(log|info|debug)"/.test(line))).toEqual([]);
  });

  it('has no code that stores, logs or calls out', () => {
    const code = ['index.ts', 'limits.ts'].map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const pattern of [/\.storage\b/, /\bconsole\./, /\bcaches\b/, /\bfetch\(\s*['"`h]/, /\bconnect\(/, /\bKVNamespace\b/, /\bD1Database\b/, /\bR2Bucket\b/]) {
      expect(code, String(pattern)).not.toMatch(pattern);
    }
  });
});
