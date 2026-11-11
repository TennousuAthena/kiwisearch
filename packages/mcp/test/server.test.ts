import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BridgeHub } from '../src/bridge';
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
});
