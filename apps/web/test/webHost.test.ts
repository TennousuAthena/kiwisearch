import { describeHostContract } from '@kiwi-search/app/testing';
import { createBridgeClient, createBridgeRelay, type StreamPort } from '@kiwi-search/protocol';
import { describe, expect, it } from 'vitest';
import { createQueue, createWebHost } from '../src/webHost';

/** A stream to the "service worker" that sends back whatever it is sent. */
function echoStream() {
  const onMessage: Array<(m: unknown) => void> = [];
  const onDisconnect: Array<() => void> = [];
  return {
    postMessage: (m: unknown) => queueMicrotask(() => onMessage.forEach((l) => l(m))),
    disconnect: () => {},
    onMessage: { addListener: (l: (m: unknown) => void) => { onMessage.push(l); } },
    onDisconnect: { addListener: (l: () => void) => { onDisconnect.push(l); } },
    hangUp: () => onDisconnect.forEach((l) => l()),
  } satisfies StreamPort & { hangUp(): void };
}

/** The website's host over a real bridge (private ports, the real relay and client), with a stand-in for the service worker behind it. */
async function website() {
  const world = { prefs: {} as Record<string, unknown>, academic: 'any' as string, streams: [] as Array<ReturnType<typeof echoStream>>, calls: [] as Array<[string, unknown]> };
  const channel = new MessageChannel();
  const relay = createBridgeRelay(channel.port2, {
    hello: async () => ({ state: 'ok', ext: '0.1.0', caps: [] }),
    request: async (method, params) => {
      world.calls.push([method, params]);
      const p = (params ?? {}) as Record<string, any>;
      switch (method) {
        case 'prefs.load': return { values: { ...world.prefs } };
        case 'prefs.save': Object.assign(world.prefs, p.values); return {};
        case 'academicLanguage.load': return { language: world.academic };
        case 'academicLanguage.save': world.academic = p.language; return {};
        case 'domainPreference': return { undo: { domain: p.domain, before: { blocked: false, boosted: false }, after: { blocked: p.action === 'block', boosted: false }, revision: 'r1' } };
        case 'undoDomainPreference': return { restored: true };
        case 'favicon': return { src: null };
        default: return {};
      }
    },
    openStream: () => { const s = echoStream(); world.streams.push(s); return s; },
  });
  const client = createBridgeClient(channel.port1);
  await client.hello();
  const host = createWebHost(client, { origin: 'https://kiwi.moe' });
  return { host, world, relay, dispose: () => { client.close(); relay.close(); channel.port1.close(); channel.port2.close(); } };
}

describeHostContract('website over the bridge', async () => {
  const { host, world, relay, dispose } = await website();
  return { host, dispose, changePreferencesElsewhere: (values) => relay.push('prefs', values), hangUpStreamsElsewhere: () => world.streams.forEach((s) => s.hangUp()) };
});

describe('the website host', () => {
  it('writes hash addresses, links home to the site and has no settings link to follow', async () => {
    const { host, dispose } = await website();
    expect(host.urlStyle).toBe('hash');
    expect(host.homeUrl).toBe('https://kiwi.moe/');
    expect(host.optionsUrl).toBe('#');
    dispose();
  });

  it('asks the extension to open the settings, at a section when there is one', async () => {
    const { host, world, dispose } = await website();
    host.openOptions?.('sources');
    host.openOptions?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(world.calls.filter(([m]) => m === 'openOptions').map(([, p]) => p)).toEqual([{ section: 'sources' }, undefined]);
    dispose();
  });

  it('turns a bad academic language from the extension into "no limit"', async () => {
    const { host, world, dispose } = await website();
    world.academic = 'fr';
    expect(await host.academicLanguage.load()).toBe('any');
    dispose();
  });

  it('ignores a push that is not a preference object', async () => {
    const { host, relay, dispose } = await website();
    const seen: unknown[] = [];
    host.preferences.subscribe((c) => seen.push(c));
    relay.push('prefs', 'oops'); relay.push('prefs', [1]); relay.push('other', { a: 1 }); relay.push('prefs', { 'ui:theme': 'light' });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([{ 'ui:theme': 'light' }]);
    dispose();
  });

  it('asks for at most six site icons at a time, so the relay never answers busy', async () => {
    const queue = createQueue(6);
    let active = 0; let peak = 0;
    const release: Array<() => void> = [];
    const jobs = Array.from({ length: 20 }, () => queue(() => new Promise<void>((resolve) => { active++; peak = Math.max(peak, active); release.push(() => { active--; resolve(); }); })));
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(6);
    while (release.length) { release.shift()!(); await new Promise((r) => setTimeout(r, 1)); }
    await Promise.all(jobs);
    expect(peak).toBe(6);
  });
});
