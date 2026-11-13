import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BridgeHub, type BridgeRequest } from '../src/bridge';
import { createMcpServer } from '../src/server';

describe('MCP server smoke test', () => {
  let hub: BridgeHub | undefined;
  let extension: WebSocket | undefined;

  afterEach(async () => {
    extension?.close();
    extension = undefined;
    if (hub) await hub.close();
    hub = undefined;
  });

  it('lists tools and calls search through a fake extension WebSocket', async () => {
    hub = new BridgeHub('smoke-token', { port: 0, extensionId: 'smoke-extension' });
    await hub.start();
    extension = new WebSocket(`ws://127.0.0.1:${hub.port}/extension`, { origin: 'chrome-extension://smoke-extension' });
    await new Promise<void>((resolve) => extension!.once('open', resolve));
    const ready = new Promise<void>((resolve) => extension!.once('message', () => resolve()));
    extension.send(JSON.stringify({ type: 'hello', token: 'smoke-token' }));
    await ready;
    extension.on('message', (data) => {
      const request = JSON.parse(data.toString()) as { id: string; type: string; query?: string };
      if (request.type !== 'search') return;
      extension?.send(JSON.stringify({
        id: request.id,
        type: 'result',
        result: {
          query: request.query,
          sourceStats: [{ source: 'bing', count: 0, ms: 1, status: 'blocked' }],
          results: [{
            key: 'example.com',
            url: 'https://example.com/',
            title: 'Fusion result',
            snippet: 'A result from the fake browser',
            sources: [{ source: 'google', rank: 1 }],
          }],
        },
      }));
    });

    const server = createMcpServer(hub);
    const client = new Client({ name: 'smoke-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(['search', 'answer', 'list_sources']);
    const result = await client.callTool({ name: 'search', arguments: { query: 'fusion' } });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('Fusion result') })]));
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('尚未完成验证的来源：bing') })]));
    expect(result.structuredContent).toMatchObject({ results: [{ title: 'Fusion result', n: 1 }], blockedSources: ['bing'] });
    await client.close();
    await server.close();
  });

  it('tells the agent how the query was understood and which named papers were confirmed', async () => {
    hub = new BridgeHub('smoke-token', { port: 0, extensionId: 'smoke-extension' });
    await hub.start();
    extension = new WebSocket(`ws://127.0.0.1:${hub.port}/extension`, { origin: 'chrome-extension://smoke-extension' });
    await new Promise<void>((resolve) => extension!.once('open', resolve));
    const ready = new Promise<void>((resolve) => extension!.once('message', () => resolve()));
    extension.send(JSON.stringify({ type: 'hello', token: 'smoke-token' }));
    await ready;
    extension.on('message', (data) => {
      const request = JSON.parse(data.toString()) as { id: string; type: string; query?: string };
      if (request.type !== 'search') return;
      extension?.send(JSON.stringify({
        id: request.id,
        type: 'result',
        result: {
          query: request.query,
          sourceStats: [],
          plan: { intent: '想找 Transformer 的原始论文', keywords: ['transformer', 'self-attention'], queries: {} },
          landmarks: [{ title: 'Attention Is All You Need', year: 2017 }],
          results: [{ key: 'a', url: 'https://example.com/a', title: 'Attention Is All You Need', snippet: 's', sources: [{ source: 'openalex', rank: 1 }] }],
        },
      }));
    });
    const server = createMcpServer(hub);
    const client = new Client({ name: 'smoke-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'search', arguments: { query: 'transformer', mode: 'academic' } });
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('检索理解：想找 Transformer 的原始论文') })]));
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('已核对存在的核心文献：Attention Is All You Need（2017）') })]));
    expect(result.structuredContent).toMatchObject({ plan: { intent: '想找 Transformer 的原始论文' }, landmarks: [{ title: 'Attention Is All You Need' }] });
    await client.close();
    await server.close();
  });

  it('keeps filtered results out of the list but reports them', async () => {
    hub = new BridgeHub('smoke-token', { port: 0, extensionId: 'smoke-extension' });
    await hub.start();
    extension = new WebSocket(`ws://127.0.0.1:${hub.port}/extension`, { origin: 'chrome-extension://smoke-extension' });
    await new Promise<void>((resolve) => extension!.once('open', resolve));
    const ready = new Promise<void>((resolve) => extension!.once('message', () => resolve()));
    extension.send(JSON.stringify({ type: 'hello', token: 'smoke-token' }));
    await ready;
    extension.on('message', (data) => {
      const request = JSON.parse(data.toString()) as { id: string };
      extension?.send(JSON.stringify({
        id: request.id,
        type: 'result',
        result: {
          sourceStats: [],
          results: [
            { url: 'https://good.example/', title: 'Good', snippet: 's', sources: [] },
            { url: 'https://farm.example/', title: 'Farm', snippet: 's', sources: [], hidden: { reason: 'junk' } },
            { url: 'https://listed.example/', title: 'Listed', snippet: 's', sources: [], hidden: { reason: 'blocked', list: 'Content Farm Terminator' } },
            { url: 'https://mine.example/', title: 'Mine', snippet: 's', sources: [], hidden: { reason: 'blocked' } },
          ],
        },
      }));
    });
    const server = createMcpServer(hub);
    const client = new Client({ name: 'smoke-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'search', arguments: { query: 'fusion' } });
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toContain('Good');
    expect(text).not.toContain('Farm');
    expect(text).toContain('3 条结果被过滤');
    expect(text).not.toContain('图片：');
    expect(result.structuredContent).toMatchObject({
      results: [{ title: 'Good', n: 1 }],
      hidden: [
        { title: 'Farm', url: 'https://farm.example/', reason: 'junk' },
        // A block list says which one; the user's own site list has no name.
        { title: 'Listed', url: 'https://listed.example/', reason: 'blocked', list: 'Content Farm Terminator' },
        { title: 'Mine', url: 'https://mine.example/', reason: 'blocked' },
      ],
    });
    expect((result.structuredContent as { hidden: object[] }).hidden[2]).not.toHaveProperty('list');
    await client.close();
    await server.close();
  });

  it('passes the language limit of an academic search on to the browser, and refuses a language it does not know', async () => {
    hub = new BridgeHub('smoke-token', { port: 0, extensionId: 'smoke-extension' });
    await hub.start();
    extension = new WebSocket(`ws://127.0.0.1:${hub.port}/extension`, { origin: 'chrome-extension://smoke-extension' });
    await new Promise<void>((resolve) => extension!.once('open', resolve));
    const ready = new Promise<void>((resolve) => extension!.once('message', () => resolve()));
    extension.send(JSON.stringify({ type: 'hello', token: 'smoke-token' }));
    await ready;
    const asked: { type: string; options?: { mode?: string; language?: string } }[] = [];
    extension.on('message', (data) => {
      const request = JSON.parse(data.toString()) as { id: string; type: string; query?: string; options?: { mode?: string; language?: string } };
      if (request.type !== 'search' && request.type !== 'answer') return;
      asked.push(request);
      extension?.send(JSON.stringify({
        id: request.id,
        type: 'result',
        result: {
          query: request.query,
          sourceStats: [],
          summary: 'An overview [1].',
          citations: [{ n: 1, url: 'https://example.com/a', title: 'A' }],
          results: [
            { key: 'a', url: 'https://example.com/a', title: 'A', snippet: 's', sources: [] },
            { key: 'b', url: 'https://example.com/b', title: '深度学习综述', snippet: 's', sources: [], hidden: { reason: 'language' } },
          ],
        },
      }));
    });
    const server = createMcpServer(hub);
    const client = new Client({ name: 'smoke-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const searched = await client.callTool({ name: 'search', arguments: { query: 'deep learning', mode: 'academic', language: 'en' } });
    await client.callTool({ name: 'answer', arguments: { query: 'deep learning', mode: 'academic', language: 'en' } });
    await client.callTool({ name: 'search', arguments: { query: 'deep learning', mode: 'academic' } });
    expect(asked.map((r) => [r.type, r.options?.mode, r.options?.language])).toEqual([
      ['search', 'academic', 'en'],
      ['answer', 'academic', 'en'],
      ['search', 'academic', undefined],
    ]);
    // What the language limit hid is reported with its reason, like any other hidden result.
    expect((searched.structuredContent as { hidden: object[] }).hidden).toEqual([{ title: '深度学习综述', url: 'https://example.com/b', reason: 'language' }]);
    expect((searched.content as { text: string }[])[0].text).toContain('语言不符');
    const refused = await client.callTool({ name: 'search', arguments: { query: 'deep learning', mode: 'academic', language: 'zh' } }).catch((error: unknown) => error);
    expect(asked).toHaveLength(3);
    expect(refused instanceof Error || (refused as { isError?: boolean }).isError).toBeTruthy();
    await client.close();
    await server.close();
  });
});

it('supports news filters and refresh in search/answer, with honest dates and incomplete snapshots', async () => {
  const requests: BridgeRequest[] = [];
  const news = { range: 'week', sort: 'date', requestedAt: '2026-11-13T01:00:00Z', summaryAt: '2026-11-13T01:00:03Z' };
  const server = createMcpServer({ request: async (request) => {
    requests.push(request);
    return { type: 'result', result: {
      mode: 'news', news, summary: 'A report [1].', citations: [{ n: 1, title: 'Report', url: 'https://example.com/news' }],
      sourceStats: [{ source: 'google', count: 1, ms: 800 }, { source: 'bravesearch', count: 0, ms: 6000, status: 'late' }],
      results: [
        { title: 'Report', url: 'https://example.com/news', snippet: 's', publishedAt: '2026-11-12T12:30:00Z', sources: [], news: { publisher: 'Example News', byline: 'Reporter', timeKind: 'published', retrievedAt: '2026-11-13T01:00:01Z' } },
        { title: 'Unknown date', url: 'https://example.com/unknown', hidden: { reason: 'time', detail: 'unknown' } },
      ],
    } };
  } });
  const client = new Client({ name: 'news-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const args = { query: 'climate', mode: 'news', news: { range: 'week', sort: 'date' }, refresh: true };
    const search = await client.callTool({ name: 'search', arguments: args });
    const answer = await client.callTool({ name: 'answer', arguments: args });
    expect(requests.map((request) => [request.type, request.options?.news, request.options?.refresh])).toEqual([
      ['search', args.news, true], ['answer', args.news, true],
    ]);
    const text = (search.content as { text: string }[])[0].text;
    expect(text).toContain('新闻：Example News · Reporter · 发布于 2026-11-12T12:30:00Z');
    expect(text).not.toContain('知乎');
    expect(text).toContain('部分来源未完成');
    for (const result of [search, answer]) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ news, incomplete: true, hidden: [{ reason: 'time', detail: 'unknown' }] });
    }
    const invalid = await client.callTool({ name: 'search', arguments: { ...args, news: { range: 'year' } } }).catch((error: unknown) => error);
    expect(invalid instanceof Error || (invalid as { isError?: boolean }).isError).toBeTruthy();
    expect(requests).toHaveLength(2);
  } finally {
    await client.close();
    await server.close();
  }
});

it('forwards shopping search, retains observed product details and rejects shopping answers before calling the browser', async () => {
  const requests: BridgeRequest[] = [];
  const product = { thumbnail: 'https://example.com/product.jpg', price: '$29.99', shop: 'Example Store', sales: '100+ bought in past month', rating: '4.5 out of 5 stars' };
  const server = createMcpServer({ request: async (request) => {
    requests.push(request);
    return { type: 'result', result: {
      mode: 'shopping', sourceStats: [{ source: 'amazon', count: 2, ms: 100 }, { source: 'taobao', count: 0, ms: 200, status: 'blocked', blockedReason: 'login' }],
      results: [
        { title: 'Wireless mouse', url: 'https://www.amazon.com/dp/B000000001', snippet: '', sources: [{ source: 'amazon', rank: 1 }], product },
        { title: 'Mouse without price', url: 'https://www.amazon.com/dp/B000000002', snippet: '', sources: [{ source: 'amazon', rank: 2 }], product: { thumbnail: 'https://example.com/other.jpg' } },
      ],
    } };
  } });
  const client = new Client({ name: 'shopping-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const args = { query: 'wireless mouse', mode: 'shopping', sources: ['taobao', 'jd', 'amazon'] };
    const result = await client.callTool({ name: 'search', arguments: args });
    expect(result.isError).not.toBe(true);
    expect(requests).toMatchObject([{ type: 'search', query: args.query, options: { mode: 'shopping', sources: args.sources, summarize: false } }]);
    expect(result.structuredContent).toMatchObject({ results: [{ n: 1, product }, { n: 2, product: { thumbnail: 'https://example.com/other.jpg' } }], blockedSources: ['taobao'] });
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toContain('商品：页面价格 $29.99 · Example Store · 100+ bought in past month · 4.5 out of 5 stars');
    expect(text.match(/页面价格/g)).toHaveLength(1);
    expect(text).toContain('需要先在浏览器里登录的来源：taobao');
    const answer = await client.callTool({ name: 'answer', arguments: args });
    expect(answer.isError).toBe(true);
    expect((answer.content as { text: string }[])[0].text).toContain('请改用 search');
    expect(requests).toHaveLength(1);
  } finally {
    await client.close();
    await server.close();
  }
});
