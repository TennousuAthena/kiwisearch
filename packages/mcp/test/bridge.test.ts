import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { allowedExtensionOrigin, BridgeHub, NOT_CONNECTED_MESSAGE, PAIRING_MISMATCH_MESSAGE, RelayClient } from '../src/bridge';

const hubs: BridgeHub[] = [];
const sockets: WebSocket[] = [];

async function makeHub() {
  const hub = new BridgeHub('correct-token', { port: 0, extensionId: 'test-extension', timeoutMs: 1000 });
  await hub.start();
  hubs.push(hub);
  return hub;
}

async function connectExtension(hub: BridgeHub, token = 'correct-token') {
  const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/extension`, { origin: 'chrome-extension://test-extension' });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => resolve());
  });
  const ready = nextMessage(socket);
  socket.send(JSON.stringify({ type: 'hello', token }));
  await ready;
  return socket;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const listener = (data: WebSocket.RawData) => {
      socket.off('message', listener);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    socket.on('message', listener);
  });
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

describe('MCP WebSocket bridge', () => {
  it('rejects non-extension origins', async () => {
    const hub = await makeHub();
    const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/extension`, { origin: 'https://attacker.example' });
    sockets.push(socket);
    await expect(new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    })).rejects.toBeTruthy();
  });

  it('accepts Chromium and Firefox extension origins, and the configured ID only', () => {
    expect(allowedExtensionOrigin('chrome-extension://abc')).toBe(true);
    expect(allowedExtensionOrigin('moz-extension://5f1c-uuid')).toBe(true);
    expect(allowedExtensionOrigin('moz-extension://5f1c-uuid', '5f1c-uuid')).toBe(true);
    expect(allowedExtensionOrigin('moz-extension://other', '5f1c-uuid')).toBe(false);
    expect(allowedExtensionOrigin('https://moz-extension.example')).toBe(false);
    expect(allowedExtensionOrigin(undefined)).toBe(false);
  });

  it('rejects a wrong pairing token', async () => {
    const hub = await makeHub();
    const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/extension`, { origin: 'chrome-extension://test-extension' });
    sockets.push(socket);
    await new Promise<void>((resolve) => socket.once('open', resolve));
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    socket.send(JSON.stringify({ type: 'hello', token: 'wrong-token' }));
    await expect(closed).resolves.toEqual({ code: 4001, reason: PAIRING_MISMATCH_MESSAGE });
  });

  it('routes requests and responses by request ID', async () => {
    const hub = await makeHub();
    const extension = await connectExtension(hub);
    const requestPromise = hub.request({ type: 'search', query: 'fusion' });
    const request = await nextMessage(extension);
    expect(request.type).toBe('search');
    expect(typeof request.id).toBe('string');
    extension.send(JSON.stringify({ id: request.id, type: 'result', result: { results: [] } }));
    await expect(requestPromise).resolves.toMatchObject({ type: 'result', result: { results: [] } });
  });

  it('returns the plugin-not-connected error', async () => {
    const hub = await makeHub();
    await expect(hub.request({ type: 'search', query: 'fusion' })).rejects.toThrow(NOT_CONNECTED_MESSAGE);
  });

  it('relays requests from a second MCP process through the hub', async () => {
    const hub = await makeHub();
    const extension = await connectExtension(hub);
    const relay = await RelayClient.connect(hub.port, 'correct-token', 1000);
    const response = nextMessage(extension);
    const requestPromise = relay.request({ type: 'search', query: 'relay query' });
    const request = await response;
    expect(request.query).toBe('relay query');
    extension.send(JSON.stringify({ id: request.id, type: 'result', result: { ok: true } }));
    await expect(requestPromise).resolves.toMatchObject({ type: 'result', result: { ok: true } });
    relay.close();
  });
});
