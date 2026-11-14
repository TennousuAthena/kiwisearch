import { describe, expect, it } from 'vitest';
import { BridgeRequestError, chooseProtocol, createBridgeClient, createBridgeRelay, parseClientMessage, SUPPORTED_PROTOCOLS, type RelayDeps, type StreamPort } from '../src';

/** A stream to the service worker that records what it is sent and lets the test speak for it. */
function fakeStream() {
  const onMessage: Array<(m: unknown) => void> = [];
  const onDisconnect: Array<() => void> = [];
  const stream = {
    sent: [] as unknown[],
    disconnected: false,
    postMessage(m: unknown) { stream.sent.push(m); },
    disconnect() { stream.disconnected = true; },
    onMessage: { addListener: (l: (m: unknown) => void) => { onMessage.push(l); } },
    onDisconnect: { addListener: (l: () => void) => { onDisconnect.push(l); } },
    say: (m: unknown) => onMessage.forEach((l) => l(m)),
    hangUp: () => onDisconnect.forEach((l) => l()),
  };
  return stream satisfies StreamPort & Record<string, unknown>;
}

function setup(overrides: Partial<RelayDeps> = {}) {
  const channel = new MessageChannel();
  const streams: ReturnType<typeof fakeStream>[] = [];
  const deps: RelayDeps = {
    hello: async () => ({ state: 'ok', ext: '0.1.0', caps: ['stream:search'] }),
    request: async (method, params) => ({ method, params }),
    openStream: () => { const s = fakeStream(); streams.push(s); return s; },
    ...overrides,
  };
  const relay = createBridgeRelay(channel.port2, deps);
  const client = createBridgeClient(channel.port1);
  const done = () => { client.close(); relay.close(); channel.port1.close(); channel.port2.close(); };
  return { relay, client, streams, done };
}

/** The page side without the client, to send things the client would never send. */
function raw(deps: Partial<RelayDeps> = {}) {
  const channel = new MessageChannel();
  const inbox: unknown[] = [];
  channel.port1.onmessage = (e) => inbox.push(e.data);
  const relay = createBridgeRelay(channel.port2, {
    hello: async () => ({ state: 'ok', ext: '0.1.0', caps: [] }), request: async () => 'done', openStream: () => fakeStream(), ...deps,
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { relay, send: (m: unknown) => channel.port1.postMessage(m), inbox, settle, done: () => { relay.close(); channel.port1.close(); channel.port2.close(); } };
}

describe('handshake', () => {
  it('welcomes a page with the protocol number both sides know and the extension version and capabilities', async () => {
    const { client, done } = setup();
    expect(await client.hello()).toEqual({ state: 'ok', protocol: SUPPORTED_PROTOCOLS.at(-1), ext: '0.1.0', caps: ['stream:search'] });
    done();
  });

  it('says what it supports when no protocol number matches', async () => {
    const { send, inbox, settle, done } = raw();
    send({ t: 'hello', protocols: [99] });
    await settle();
    expect(inbox).toEqual([{ t: 'incompatible', protocols: [...SUPPORTED_PROTOCOLS] }]);
    done();
  });

  it('picks the highest number both sides know', () => {
    expect(chooseProtocol([1, 2, 3], [1, 2])).toBe(2);
    expect(chooseProtocol([5], [1, 2])).toBeNull();
  });

  it('tells the page when the extension is set to refuse websites, and then refuses its requests', async () => {
    const { client, done } = setup({ hello: async () => ({ state: 'disabled' }) });
    expect(await client.hello()).toEqual({ state: 'disabled' });
    await expect(client.request('favicon', { host: 'a.com' })).rejects.toMatchObject({ code: 'not_ready' });
    done();
  });

  it('says unavailable when the service worker cannot be reached', async () => {
    const { client, done } = setup({ hello: () => Promise.reject(new Error('Extension context invalidated')) });
    expect(await client.hello()).toEqual({ state: 'unavailable' });
    done();
  });

  it('gives up waiting for an extension that never answers', async () => {
    const channel = new MessageChannel();
    const client = createBridgeClient(channel.port1);
    expect(await client.hello(30)).toEqual({ state: 'unavailable' });
    client.close(); channel.port2.close();
  });
});

describe('requests', () => {
  it('passes a request to the service worker and returns the answer', async () => {
    const { client, done } = setup();
    await client.hello();
    expect(await client.request('favicon', { host: 'a.com' })).toEqual({ method: 'favicon', params: { host: 'a.com' } });
    done();
  });

  it('keeps the code and message of a refusal and hides anything else a failure carries', async () => {
    const { client, done } = setup({ request: async (method) => { throw method === 'a' ? { code: 'invalid', message: 'bad host', secret: 'x' } : new Error('boom'); } });
    await client.hello();
    await expect(client.request('a')).rejects.toMatchObject({ code: 'invalid', message: 'bad host' });
    await expect(client.request('b')).rejects.toBeInstanceOf(BridgeRequestError);
    await expect(client.request('b')).rejects.toMatchObject({ code: 'failed', message: 'boom' });
    done();
  });

  it('refuses requests before the handshake', async () => {
    const { client, done } = setup();
    await expect(client.request('favicon', {})).rejects.toMatchObject({ code: 'not_ready' });
    done();
  });

  it('lets a page ask to open the local interface without a handshake, and nothing else', async () => {
    const { client, done } = setup();
    await expect(client.request('openLocal', { query: 'x' })).resolves.toEqual({ method: 'openLocal', params: { query: 'x' } });
    await expect(client.request('prefs.load')).rejects.toMatchObject({ code: 'not_ready' });
    done();
  });

  it('answers busy beyond the number of requests allowed at once', async () => {
    const release: Array<() => void> = [];
    const { client, done } = setup({ limits: { maxInFlight: 2 }, request: () => new Promise((resolve) => { release.push(() => resolve('ok')); }) });
    await client.hello();
    const first = client.request('a'); const second = client.request('a'); const third = client.request('a');
    await expect(third).rejects.toMatchObject({ code: 'busy' });
    release.forEach((r) => r());
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok']);
    done();
  });

  it('times a request out instead of waiting for ever', async () => {
    const { client, done } = setup({ request: () => new Promise(() => {}) });
    await client.hello();
    await expect(client.request('slow', undefined, 30)).rejects.toMatchObject({ code: 'timeout' });
    done();
  });
});

describe('streams', () => {
  it('carries messages both ways and tells each side when the other hangs up', async () => {
    const { client, streams, done } = setup();
    await client.hello();
    const stream = client.connect('search');
    const received: unknown[] = []; let closed = 0;
    stream.onMessage.addListener((m) => received.push(m));
    stream.onDisconnect.addListener(() => { closed++; });
    stream.postMessage({ type: 'search', query: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    expect(streams).toHaveLength(1);
    expect(streams[0].sent).toEqual([{ type: 'search', query: 'x' }]);
    streams[0].say({ type: 'fatal', error: 'nope' });
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([{ type: 'fatal', error: 'nope' }]);
    streams[0].hangUp();
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(1);
    done();
  });

  it('disconnects the service worker stream when the page disconnects, and when the relay closes', async () => {
    const { client, relay, streams, done } = setup();
    await client.hello();
    const a = client.connect('search'); client.connect('summary');
    await new Promise((r) => setTimeout(r, 20));
    a.disconnect();
    await new Promise((r) => setTimeout(r, 20));
    expect(streams[0].disconnected).toBe(true);
    expect(streams[1].disconnected).toBe(false);
    relay.close();
    expect(streams[1].disconnected).toBe(true);
    done();
  });

  it('refuses streams beyond the limit and before the handshake', async () => {
    const { client, streams, done } = setup({ limits: { maxStreams: 2 } });
    const early = client.connect('search');
    let earlyClosed = false; early.onDisconnect.addListener(() => { earlyClosed = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(earlyClosed).toBe(true);
    await client.hello();
    const opened = ['search', 'summary', 'search'].map((name) => {
      const s = client.connect(name as 'search'); let closed = false; s.onDisconnect.addListener(() => { closed = true; }); return () => closed;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(streams).toHaveLength(2);
    expect(opened.map((closed) => closed())).toEqual([false, false, true]);
    done();
  });
});

describe('pushes', () => {
  it('reaches the page after the handshake and not before', async () => {
    const { client, relay, done } = setup();
    const got: unknown[] = [];
    client.onPush((name, data) => got.push([name, data]));
    relay.push('prefs', { a: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
    await client.hello();
    relay.push('prefs', { a: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([['prefs', { a: 2 }]]);
    done();
  });
});

describe('a page that misbehaves', () => {
  it('is dropped without an answer when a message is not exactly a known shape', async () => {
    const { send, inbox, settle, done } = raw();
    for (const junk of [null, 'hello', 5, [], {}, { t: 'nope' }, { t: 'req', id: 0, method: 'x' }, { t: 'req', id: 1.5, method: 'x' }, { t: 'req', id: 1, method: 'x'.repeat(41) },
      { t: 'open', ch: 1, name: 'admin' }, { t: 'hello', protocols: [] }, { t: 'hello', protocols: 'one' }]) send(junk);
    await settle();
    expect(inbox).toEqual([]);
    done();
  });

  it('is cut off after too many violations', async () => {
    const { send, inbox, settle, done } = raw({ limits: { maxViolations: 3 } });
    for (let i = 0; i < 5; i++) send({ junk: i });
    await settle();
    send({ t: 'hello', protocols: [1] });
    await settle();
    expect(inbox).toEqual([]);
    done();
  });

  it('parses only the messages a page may send', () => {
    expect(parseClientMessage({ t: 'msg', ch: 3, data: { a: 1 } })).toEqual({ t: 'msg', ch: 3, data: { a: 1 } });
    expect(parseClientMessage({ t: 'msg', ch: 0, data: 1 })).toBeNull();
    expect(parseClientMessage({ t: 'welcome', protocol: 1 })).toBeNull();
  });
});
