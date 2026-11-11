import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { RelayClient } from '../src/bridge';
import { createMcpServer } from '../src/server';
import { BridgeSession } from '../src/session';

const TOKEN = 'session-token';
const sessions: BridgeSession[] = [];
const sockets: WebSocket[] = [];
const servers: WebSocketServer[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

function makeSession(port: number) {
  const session = new BridgeSession(TOKEN, { port, extensionId: 'test-extension', timeoutMs: 2000, takeoverJitterMs: 20 });
  sessions.push(session);
  return session;
}

async function attachExtension(port: number, onRequest: (request: Record<string, unknown>, reply: (payload: object) => void) => void) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: 'chrome-extension://test-extension' });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => resolve());
  });
  const ready = new Promise<void>((resolve) => socket.once('message', () => resolve()));
  socket.send(JSON.stringify({ type: 'hello', token: TOKEN }));
  await ready;
  socket.on('message', (data) => {
    const request = JSON.parse(data.toString()) as Record<string, unknown>;
    if (request.type === 'cancel') return;
    onRequest(request, (payload) => socket.send(JSON.stringify({ id: request.id, ...payload })));
  });
  return socket;
}

async function until(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) server.close();
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

describe('BridgeSession', () => {
  it('becomes the hub first and a relay second, and both reach the extension', async () => {
    const port = await freePort();
    const first = makeSession(port);
    await first.start();
    const second = makeSession(port);
    await second.start();
    expect([first.role, second.role]).toEqual(['hub', 'relay']);
    await attachExtension(port, (request, reply) => reply({ type: 'result', result: { echoed: request.query } }));
    await expect(first.request({ type: 'search', query: 'from hub' })).resolves.toMatchObject({ result: { echoed: 'from hub' } });
    await expect(second.request({ type: 'search', query: 'from relay' })).resolves.toMatchObject({ result: { echoed: 'from relay' } });
  });

  it('lets a relay take over the port when the hub process goes away', async () => {
    const port = await freePort();
    const hub = makeSession(port);
    await hub.start();
    const relay = makeSession(port);
    await relay.start();
    expect(relay.role).toBe('relay');

    await hub.close();
    await until(() => relay.role === 'hub');

    await attachExtension(port, (request, reply) => reply({ type: 'result', result: { echoed: request.query } }));
    await expect(relay.request({ type: 'search', query: 'after takeover' })).resolves.toMatchObject({
      result: { echoed: 'after takeover' },
    });
  });

  it('rejects after close instead of reconnecting', async () => {
    const session = makeSession(await freePort());
    await session.start();
    await session.close();
    await expect(session.request({ type: 'list_sources' })).rejects.toThrow('closed');
  });

  it('forwards the search mode through the MCP tools', async () => {
    const port = await freePort();
    const session = makeSession(port);
    await session.start();
    const seen: unknown[] = [];
    await attachExtension(port, (request, reply) => {
      seen.push(request.options);
      reply({ type: 'result', result: { results: [], sourceStats: [] } });
    });
    const server = createMcpServer(session);
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: 'search', arguments: { query: 'attention', mode: 'academic' } });
    await client.callTool({ name: 'search', arguments: { query: 'attention' } });
    expect(seen[0]).toMatchObject({ mode: 'academic', limit: 10, summarize: false });
    expect(seen[1]).not.toHaveProperty('mode');
    const accepted = await client.callTool({ name: 'search', arguments: { query: 'cat', mode: 'images' } });
    expect(accepted.isError).not.toBe(true);
    expect(seen[2]).toMatchObject({ mode: 'images' });
    const video = await client.callTool({ name: 'search', arguments: { query: 'cat', mode: 'video' } });
    expect(video.isError).not.toBe(true);
    expect(seen[3]).toMatchObject({ mode: 'video' });
    for (const mode of ['images', 'video', 'xiaohongshu', 'x']) {
      const answered = await client.callTool({ name: 'answer', arguments: { query: 'cat', mode } });
      expect(answered.isError).toBe(true);
      expect((answered.content as { text: string }[])[0].text).toContain('请改用 search');
    }
    expect(seen).toHaveLength(4); // the refused answers never reached the browser
    const invalid = await client.callTool({ name: 'search', arguments: { query: 'x', mode: 'nonsense' } });
    expect(invalid.isError).toBe(true);
    await client.close();
    await server.close();
  });
});

describe('result formatting', () => {
  it('adds paper metadata and image details to the text', async () => {
    const port = await freePort();
    const session = makeSession(port);
    await session.start();
    await attachExtension(port, (_request, reply) =>
      reply({
        type: 'result',
        result: {
          sourceStats: [],
          results: [
            { url: 'https://doi.org/10.1/x', title: 'A paper', snippet: 'abs', sources: [], meta: { authors: ['A', 'B'], venue: 'NeurIPS', year: 2020, citations: 42, pdfUrl: 'https://x.example/p.pdf' } },
            { url: 'https://page.example/', title: 'A picture', snippet: '', sources: [], image: { src: 'https://cdn.example/a.jpg', width: 800, height: 600, license: 'CC BY 4.0' } },
            { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'A video', snippet: '', sources: [], video: { channel: 'Some Channel', duration: '8:16', views: '11,007 views', published: '2y ago' } },
            { url: 'https://www.zhihu.com/question/1/answer/2', title: 'An answer', snippet: 'x', sources: [], meta: { author: '某人', votes: 423, comments: 105, age: '11-04' } },
            { url: 'https://www.rednote.com/search_result/abc', title: 'A note', snippet: '', sources: [], note: { author: '小坏、', time: '昨天 19:00', likes: '1.2万' } },
            { url: 'https://weixin.sogou.com/link?url=a', title: 'An article', snippet: 'x', sources: [], publishedAt: '2016-03-08T13:54:29.000Z', meta: { author: '灼见', siteName: '微信公众号' } },
            { url: 'https://x.com/OpenAI/status/1', title: 'OpenAI (@OpenAI)', snippet: 'Now in beta', sources: [], publishedAt: '2026-11-10T18:06:42.000Z', meta: { author: '@OpenAI', comments: 1218, reposts: 2686, votes: 16661, views: 5026349, siteName: 'X' } },
          ],
        },
      }),
    );
    const server = createMcpServer(session);
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'search', arguments: { query: 'x' } });
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toContain('A, B · NeurIPS · 2020 · 被引 42 · PDF https://x.example/p.pdf');
    expect(text).toContain('图片：https://cdn.example/a.jpg · 800×600 · CC BY 4.0');
    expect(text).toContain('视频：Some Channel · 8:16 · 11,007 views · 2y ago');
    expect(text).toContain('知乎：某人 · 423 赞同 · 105 评论 · 11-04');
    expect(text).toContain('笔记：小坏、 · 昨天 19:00 · 1.2万赞');
    expect(text).toContain('公众号：灼见 · 2016-03-08');
    expect(text).not.toContain('知乎：灼见');
    expect(text).toContain('X：@OpenAI · 2026-11-10 · 1218 回复 · 2686 转发 · 16661 喜欢 · 5026349 浏览');
    expect(text).not.toContain('知乎：@OpenAI');
    await client.close();
    await server.close();
  });
});

describe('RelayClient', () => {
  it('survives a malformed frame from the hub', async () => {
    const port = await freePort();
    const wss = new WebSocketServer({ port, host: '127.0.0.1' });
    servers.push(wss);
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as { type: string; id?: string };
        if (message.type === 'hello') {
          socket.send(JSON.stringify({ type: 'ready' }));
          socket.send('definitely not json');
          socket.send('null');
        } else if (message.type === 'search') {
          socket.send(JSON.stringify({ id: message.id, type: 'result', result: { ok: true } }));
        }
      });
    });
    const relay = await RelayClient.connect(port, TOKEN, 1000);
    await expect(relay.request({ type: 'search', query: 'q' })).resolves.toMatchObject({ result: { ok: true } });
    relay.close();
  });
});
