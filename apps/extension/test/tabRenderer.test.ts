import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserEngine, BrowserRunOptions, SourceId } from '@kiwi-search/core';

const world = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  windows: new Map<number, { id: number; type: string; incognito: boolean }>(),
  tabs: new Map<number, { id: number; windowId: number; groupId: number; pinned: boolean; url?: string }>(),
  nextWindow: 1, nextTab: 1, idleMinutes: 1,
}));
const api = vi.hoisted(() => {
  const createTab = vi.fn(async ({ windowId, ...props }: { windowId: number; url?: string }) => {
    const tab = { id: world.nextTab++, windowId, groupId: -1, pinned: false, ...props };
    world.tabs.set(tab.id, tab);
    return { ...tab };
  });
  return {
    storage: { session: {
      get: vi.fn(async () => structuredClone(world.session)),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(world.session, structuredClone(value)); }),
      remove: vi.fn(async (key: string) => { delete world.session[key]; }),
    } },
    windows: {
      create: vi.fn(async () => {
        const window = { id: world.nextWindow++, type: 'normal', incognito: false };
        world.windows.set(window.id, window);
        await createTab({ windowId: window.id });
        return { ...window };
      }),
      update: vi.fn(async () => ({})),
      get: vi.fn(async (id: number) => {
        const window = world.windows.get(id);
        if (!window) throw new Error('No window');
        return { ...window };
      }),
    },
    tabs: {
      create: createTab,
      get: vi.fn(async (id: number) => {
        const tab = world.tabs.get(id);
        if (!tab) throw new Error('No tab');
        return { ...tab };
      }),
      query: vi.fn(async ({ windowId }: { windowId: number }) => [...world.tabs.values()].filter((t) => t.windowId === windowId)),
      update: vi.fn(async (id: number, props: object) => {
        const tab = world.tabs.get(id);
        if (!tab) throw new Error('No tab');
        Object.assign(tab, props);
        return { ...tab };
      }),
      remove: vi.fn(async (id: number) => {
        const tab = world.tabs.get(id);
        world.tabs.delete(id);
        if (tab && ![...world.tabs.values()].some((t) => t.windowId === tab.windowId)) world.windows.delete(tab.windowId);
      }),
      // No tabGroups API exists in this harness. Reintroducing grouping must fail.
      group: vi.fn(async () => { throw new Error('Internal workers must not create saved groups'); }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
});
vi.mock('wxt/browser', () => ({ browser: api }));
vi.mock('../lib/settings', () => ({ loadConfig: async () => ({ renderer: { workerIdleMinutes: world.idleMinutes } }) }));
vi.mock('@kiwi-search/app/i18n', () => ({ t: (key: string) => key }));

type Renderer = typeof import('../lib/tabRenderer');
let renderer: Renderer;
const engine = (id: SourceId): BrowserEngine => ({ id, label: id, modes: ['web'], matches: ['https://example.org/*'], readySelector: 'body', blockedSelector: ':not(*)', extract: () => [], buildUrl: (query) => 'https://example.org/search?q=' + query });
const options = (minIntervalMs = 0) => ({
  count: 10, mode: 'web', language: 'en', signal: new AbortController().signal,
  renderer: { minIntervalMs, focusOnCaptcha: false }, onStart: vi.fn(), onBlocked: vi.fn(),
}) as unknown as BrowserRunOptions;
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const complete = async (tabId: number) => {
  const request = renderer.workerForTab(tabId)!;
  expect(request).not.toBeNull();
  await renderer.handleWorkerMessage({ type: 'kiwi:extracted', requestId: request.requestId, hits: [] }, { tab: world.tabs.get(tabId) } as Parameters<Renderer['handleWorkerMessage']>[1]);
};
const search = async (id: SourceId = 'google') => {
  const result = renderer.runBrowserEngine(engine(id), 'query', options());
  await flush();
  const tab = [...world.tabs.values()].find((t) => renderer.workerForTab(t.id)?.engine === id);
  expect(tab).toBeDefined();
  await complete(tab!.id);
  await result;
  await flush();
  return tab!.id;
};

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  world.session = {}; world.windows.clear(); world.tabs.clear();
  world.nextWindow = 1; world.nextTab = 1; world.idleMinutes = 1;
  renderer = await import('../lib/tabRenderer');
});
afterEach(() => vi.useRealTimers());

describe('actual worker lifecycle (mock browser; native saved groups require E2E)', () => {
  it('reuses one window across concurrent sources, then survives two GC/search cycles without grouping', async () => {
    const first = await Promise.all([search('google'), search('bing')]);
    expect(api.windows.create).toHaveBeenCalledTimes(1);
    expect(world.tabs.size).toBe(2);
    expect(await search()).toBe(first[0]);
    for (let cycle = 0; cycle < 2; cycle++) {
      vi.advanceTimersByTime(60_001);
      await renderer.collectIdleWorkers();
      expect(world.tabs.size).toBe(0);
      expect(world.session.kiwiRenderer).toBeUndefined();
      await search();
    }
    expect(api.tabs.group).not.toHaveBeenCalled();
    expect(api.windows.create).toHaveBeenCalledTimes(3);
  });
  it('does not collect an active request even beyond the idle limit', async () => {
    const pending = renderer.runBrowserEngine(engine('google'), 'slow', options());
    await flush();
    const tabId = [...world.tabs.keys()][0];
    vi.advanceTimersByTime(180_000);
    await renderer.collectIdleWorkers();
    expect(world.tabs.has(tabId)).toBe(true);
    expect(api.tabs.remove).not.toHaveBeenCalled();
    await complete(tabId); await pending;
  });
  it('protects rate-limited searches before their pending request is registered', async () => {
    const tabId = await search();
    const pending = renderer.runBrowserEngine(engine('google'), 'queued', options(180_000));
    await flush();
    expect(renderer.workerForTab(tabId)).toBeNull();
    vi.advanceTimersByTime(60_001);
    await renderer.collectIdleWorkers();
    expect(world.tabs.has(tabId)).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    await complete(tabId); await pending;
  });
  it('keeps user-grouped tabs, including unrelated tabs in the worker window', async () => {
    const tabId = await search();
    const user = await api.tabs.create({ windowId: world.tabs.get(tabId)!.windowId, url: 'https://user.example/' });
    world.tabs.get(user.id)!.groupId = 999;
    vi.advanceTimersByTime(60_001);
    await renderer.collectIdleWorkers();
    expect([...world.tabs.keys()]).toEqual([user.id]);
    expect(world.windows.size).toBe(1);
    await search();
    expect(world.tabs.has(user.id)).toBe(true);
    expect(api.tabs.group).not.toHaveBeenCalled();
  });
  it.each(['grouped', 'pinned', 'moved'] as const)('relinquishes a %s worker even if the user restores its old position', async (action) => {
    const id = await search();
    if (action === 'grouped') renderer.handleWorkerTabUpdated(id, { groupId: 999 });
    if (action === 'pinned') renderer.handleWorkerTabUpdated(id, { pinned: true });
    if (action === 'moved') renderer.forgetWorkerTab(id);
    await flush(); vi.advanceTimersByTime(60_001);
    await renderer.collectIdleWorkers();
    expect(world.tabs.has(id)).toBe(true);
    expect(await search()).not.toBe(id);
  });
  it.each(['grouped', 'pinned', 'moved'] as const)('validates actual tab ownership after a missed %s event', async (action) => {
    const id = await search();
    const tab = world.tabs.get(id)!;
    if (action === 'grouped') tab.groupId = 999;
    if (action === 'pinned') tab.pinned = true;
    if (action === 'moved') tab.windowId = 999;
    vi.advanceTimersByTime(60_001);
    await renderer.collectIdleWorkers();
    expect(world.tabs.has(id)).toBe(true);
    expect(await search()).not.toBe(id);
  });
  it.each(['missing-tab', 'missing-window', 'legacy', 'malformed', 'session-lost'] as const)(
    'recovers %s state without modifying unowned resources', async (boundary) => {
      const id = await search();
      const original = structuredClone(world.tabs.get(id));
      if (boundary === 'missing-tab') world.tabs.delete(id);
      if (boundary === 'missing-window') world.windows.delete(original!.windowId);
      if (boundary === 'legacy') world.session.kiwiRenderer = { ...(world.session.kiwiRenderer as object), version: undefined, groupId: 100 };
      if (boundary === 'malformed') world.session.kiwiRenderer = { version: 2, tabs: null };
      if (boundary === 'session-lost') world.session = {};
      vi.resetModules(); renderer = await import('../lib/tabRenderer');
      await renderer.collectIdleWorkers();
      expect(await search()).not.toBe(id);
      if (['legacy', 'malformed', 'session-lost'].includes(boundary)) expect(world.tabs.get(id)).toEqual(original);
    },
  );
  it('resumes recorded ungrouped workers after a service worker restart', async () => {
    const id = await search();
    vi.resetModules(); renderer = await import('../lib/tabRenderer');
    expect(await search()).toBe(id);
    expect(api.windows.create).toHaveBeenCalledTimes(1);
  });
});
