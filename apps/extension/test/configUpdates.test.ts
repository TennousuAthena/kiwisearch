import { DEFAULT_CONFIG, resolveLlmSettings, SOURCES } from '@kiwi-search/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ value: {} as Record<string, unknown>, get: vi.fn(), set: vi.fn(), send: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { storage: { local: { get: storage.get, set: storage.set } }, runtime: { sendMessage: storage.send } } }));
import { applyRemoteConfigPatches, handleConfigUpdate, setOnLocalSyncChanges } from '../lib/backgroundConfig';
import { applySettingsPatch, diffSettings, diffSettingsFromBaselines, undoDomainPreference, updateDomainPreference } from '../lib/configUpdates';
import { DEFAULT_BRIDGE, loadConfig, saveConfig, saveSettings } from '../lib/settings';
import { appliedChangesToLocalUpdates, readLocalSyncChanges } from '../lib/syncMapping';
import { createAutosaveQueue } from '../entrypoints/options/autosaveQueue';

beforeEach(() => {
  storage.value = { config: structuredClone(DEFAULT_CONFIG) };
  storage.get.mockReset().mockImplementation(async () => structuredClone(storage.value));
  storage.set.mockReset().mockImplementation(async (patch) => { Object.assign(storage.value, structuredClone(patch)); });
  storage.send.mockReset().mockImplementation(handleConfigUpdate);
});

describe('settings writes from multiple pages', () => {
  const source = ['sources', 'searxng'];
  const urlPath = [...source, 'baseUrl'];
  const keyPath = [...source, 'apiKey'];
  const originPath = [...source, 'apiKeyOrigin'];
  const oldUrl = 'https://old.example';
  const newUrl = 'https://other.example';

  async function authorization() {
    const config = await loadConfig();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ results: [] })));
    await SOURCES.searxng.search('sample', {
      env: { fetch }, settings: config.sources.searxng!, mode: 'web', count: 1,
      signal: new AbortController().signal, onBlocked: () => {}, onStart: () => {}, renderer: config.renderer,
    });
    return new Headers(fetch.mock.calls[0][1]?.headers).get('Authorization');
  }

  it('syncs the URL without the key header until re-saving the same key for that server', async () => {
    await handleConfigUpdate({
      type: 'kiwi:update-settings',
      config: [{ path: source, value: { enabled: true, baseUrl: oldUrl, apiKey: 'test-local' } }],
    });
    expect(await authorization()).toBe('Bearer test-local');
    await applyRemoteConfigPatches([{ path: urlPath, value: newUrl }, { path: originPath, value: newUrl }]);
    const config = await loadConfig();
    expect(config.sources.searxng).toMatchObject({ baseUrl: newUrl, apiKeyOrigin: oldUrl });
    expect(await authorization()).toBeNull();

    const next = structuredClone(config);
    next.sources.searxng!.apiKeyOrigin = newUrl;
    const recorded = vi.fn();
    setOnLocalSyncChanges(recorded);
    try {
      await saveSettings({ config: next, bridge: DEFAULT_BRIDGE }, { config, bridge: DEFAULT_BRIDGE });
      expect(recorded).toHaveBeenCalledWith([
        { path: 'config.sources.searxng.apiKey', value: 'test-local', pairedUrl: newUrl },
      ]);
    } finally {
      setOnLocalSyncChanges(null);
    }
    expect(await authorization()).toBe('Bearer test-local');
  });

  it('keeps a rotating key bound to the address shown when editing began across a peer URL update', async () => {
    await handleConfigUpdate({
      type: 'kiwi:update-settings',
      config: [{ path: source, value: { enabled: true, baseUrl: oldUrl, apiKey: 'test-local' } }],
    });
    const previous = await loadConfig();
    const blank = structuredClone(previous);
    blank.sources.searxng!.apiKey = '';
    delete blank.sources.searxng!.apiKeyOrigin;
    await saveSettings({ config: blank, bridge: DEFAULT_BRIDGE }, { config: previous, bridge: DEFAULT_BRIDGE });
    expect(await authorization()).toBeNull();
    await applyRemoteConfigPatches([{ path: urlPath, value: newUrl }]);
    const replacement = await loadConfig();
    const next = structuredClone(replacement);
    next.sources.searxng!.apiKey = 'test-rotated';
    next.sources.searxng!.apiKeyOrigin = oldUrl;
    await saveSettings({ config: next, bridge: DEFAULT_BRIDGE }, { config: replacement, bridge: DEFAULT_BRIDGE });
    expect(await authorization()).toBeNull();
    await applyRemoteConfigPatches([{ path: urlPath, value: oldUrl }]);
    expect(await authorization()).toBe('Bearer test-rotated');
  });

  it('binds a synced key only to its paired URL and never to an unrelated receiver URL', async () => {
    await applyRemoteConfigPatches([{ path: urlPath, value: oldUrl }, { path: keyPath, value: 'legacy' }]);
    expect(await authorization()).toBeNull();
    await applyRemoteConfigPatches([{ path: keyPath, value: 'paired' }], newUrl + '/search-service');
    expect(await authorization()).toBeNull();
    await applyRemoteConfigPatches([{ path: urlPath, value: newUrl }]);
    expect(await authorization()).toBe('Bearer paired');
    await applyRemoteConfigPatches([{ path: urlPath, remove: true }]);
    expect((await loadConfig()).sources.searxng).toMatchObject({ apiKeyOrigin: newUrl });
    expect((await loadConfig()).sources.searxng?.baseUrl).toBeUndefined();
  });

  it('applies only fields edited against the original page baseline', async () => {
    const firstPage = await loadConfig();
    const stalePage = await loadConfig();
    await saveConfig({ ...firstPage, summary: { ...firstPage.summary, enabled: false } }, firstPage);
    await saveConfig({ ...stalePage, sources: { ...stalePage.sources, google: { ...stalePage.sources.google!, enabled: false } } }, stalePage);
    const saved = await loadConfig();
    expect(saved.summary.enabled).toBe(false);
    expect(saved.sources.google?.enabled).toBe(false);
  });

  it('merges domain membership changes without losing later changes from results', async () => {
    const baseline = await loadConfig();
    await updateDomainPreference('block', 'other.example');
    const next = structuredClone(baseline);
    next.judge.blockedDomains.push('draft.example');
    await saveConfig(next, baseline);
    expect((await loadConfig()).judge.blockedDomains).toEqual(['other.example', 'draft.example']);
    const edit = structuredClone(next);
    edit.judge.blockedDomains = [];
    await saveConfig(edit, next);
    expect((await loadConfig()).judge.blockedDomains).toEqual(['other.example']);
  });

  it('serializes overlapping writes before reading the latest stored config', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    storage.set.mockImplementationOnce(async (patch) => { await paused; Object.assign(storage.value, structuredClone(patch)); });
    const baseline = await loadConfig();
    const first = saveConfig({ ...baseline, summary: { ...baseline.summary, enabled: false } }, baseline);
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalledTimes(1));
    const second = updateDomainPreference('boost', 'later.example');
    await Promise.resolve();
    expect(storage.set).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    const saved = await loadConfig();
    expect(saved.summary.enabled).toBe(false);
    expect(saved.judge.boostedDomains).toEqual(['later.example']);
  });

  it('preserves the existing domain state on undo and leaves unrelated changes alone', async () => {
    await updateDomainPreference('boost', 'www.example.com');
    const undo = await updateDomainPreference('block', 'https://example.com/page');
    await updateDomainPreference('block', 'another.example');
    expect(await undoDomainPreference(undo)).toBe(true);
    const saved = await loadConfig();
    expect(saved.judge.boostedDomains).toEqual(['example.com']);
    expect(saved.judge.blockedDomains).toEqual(['another.example']);
  });

  it('does not undo a newer action on the same domain', async () => {
    const undo = await updateDomainPreference('block', 'example.com');
    await updateDomainPreference('boost', 'example.com');
    expect(await undoDomainPreference(undo)).toBe(false);
    expect((await loadConfig()).judge.boostedDomains).toEqual(['example.com']);
  });

  it('invalidates an old undo even when later edits return the domain to the same state', async () => {
    const undo = await updateDomainPreference('block', 'example.com');
    await updateDomainPreference('clear', 'example.com');
    await updateDomainPreference('block', 'example.com');
    expect(await undoDomainPreference(undo)).toBe(false);
    expect((await loadConfig()).judge.blockedDomains).toEqual(['example.com']);
  });

  it('invalidates only affected receipts when an options draft changes domain membership', async () => {
    const undoFirst = await updateDomainPreference('block', 'first.example');
    const undoOther = await updateDomainPreference('block', 'other.example');
    const baseline = await loadConfig();
    const draft = structuredClone(baseline);
    draft.judge.blockedDomains = ['other.example'];
    await saveConfig(draft, baseline);
    expect(await undoDomainPreference(undoFirst)).toBe(false);
    expect(await undoDomainPreference(undoOther)).toBe(true);
  });

  it('reports failed storage writes without poisoning later retries', async () => {
    storage.set.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(updateDomainPreference('block', 'example.com')).rejects.toThrow('Storage unavailable');
    expect((await loadConfig()).judge.blockedDomains).toEqual([]);
    await updateDomainPreference('block', 'example.com');
    expect((await loadConfig()).judge.blockedDomains).toEqual(['example.com']);
  });

  it('does not rewrite unchanged settings, and rejects prototype paths', () => {
    expect(diffSettings(DEFAULT_CONFIG, structuredClone(DEFAULT_CONFIG))).toEqual([]);
    expect(() => applySettingsPatch({}, [{ path: ['__proto__', 'polluted'], value: true }])).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('publishes whole model selections and binds only explicitly saved custom keys', async () => {
    const onChange = vi.fn();
    setOnLocalSyncChanges(onChange);
    try {
      const before = await loadConfig();
      const draft = structuredClone(before);
      draft.llm.selection = { provider: 'custom', model: 'one' };
      draft.llm.profiles!.custom = { baseUrl: 'https://first.example/v1', apiKey: 'mock-key', apiKeyOrigin: 'https://first.example', model: 'one' };
      draft.judge.llm.selection = { provider: 'openrouter', model: 'two' };
      draft.judge.llm.profiles!.ollama = { baseUrl: 'http://localhost:12345/v1', model: 'local' };
      await saveConfig(draft, before);
      expect(onChange).toHaveBeenCalledWith(expect.arrayContaining([
        { path: 'config.llm.selection', value: { provider: 'custom', model: 'one' } },
        { path: 'config.llm.profiles.custom.endpoint', value: {
          baseUrl: 'https://first.example/v1', apiFormat: 'chat-completions', apiKey: 'mock-key', apiKeyOrigin: 'https://first.example',
        } },
        { path: 'config.judge.llm.selection', value: { provider: 'openrouter', model: 'two' } },
      ]));
      expect(onChange.mock.calls[0][0].map((change: { path: string }) => change.path)).toHaveLength(3);
      const { configPatches } = appliedChangesToLocalUpdates([{
        path: 'config.llm.profiles.custom.endpoint', category: 'keys', tombstone: false,
        value: { baseUrl: 'https://second.example/v1', apiFormat: 'anthropic', apiKey: 'mock-key', apiKeyOrigin: 'https://first.example' },
      }]);
      await applyRemoteConfigPatches(configPatches);
      const changed = await loadConfig();
      expect(resolveLlmSettings(changed.llm)).toEqual({ baseUrl: 'https://second.example/v1', apiFormat: 'anthropic', apiKey: '', model: 'one' });
      const rebound = structuredClone(changed);
      rebound.llm.profiles!.custom!.apiKeyOrigin = 'https://second.example';
      await saveConfig(rebound, changed);
      expect(resolveLlmSettings((await loadConfig()).llm).apiKey).toBe('mock-key');
      expect(onChange).toHaveBeenLastCalledWith([{ path: 'config.llm.profiles.custom.endpoint', value: {
        baseUrl: 'https://second.example/v1', apiFormat: 'anthropic', apiKey: 'mock-key', apiKeyOrigin: 'https://second.example',
      } }]);
    } finally {
      setOnLocalSyncChanges(null);
    }
  });

  it('keeps a local custom key on keyless endpoint edits and only clears it on an explicit clear', async () => {
    const before = await loadConfig();
    const draft = structuredClone(before);
    draft.llm.selection = { provider: 'custom', model: 'demo' };
    draft.llm.profiles!.custom = { baseUrl: 'https://custom.example/v1', apiKey: 'local-key', apiKeyOrigin: 'https://custom.example' };
    await saveConfig(draft, before);
    const path = 'config.llm.profiles.custom.endpoint';
    const endpoint = { baseUrl: 'https://custom.example/v2', apiFormat: 'anthropic' };
    const apply = (value: object) => applyRemoteConfigPatches(appliedChangesToLocalUpdates([{
      path, category: 'keys', tombstone: false, value,
    }]).configPatches);
    await apply({ ...endpoint, apiKey: '' });
    await apply(endpoint);
    const kept = await loadConfig();
    expect(resolveLlmSettings(kept.llm)).toEqual({ ...endpoint, apiKey: 'local-key', model: 'demo' });

    const cleared = structuredClone(kept);
    cleared.llm.profiles!.custom = { ...cleared.llm.profiles!.custom, apiKey: '', apiKeyOrigin: undefined, apiKeyCleared: true };
    const [record] = readLocalSyncChanges([path], cleared, {});
    expect(record.value).toEqual({ ...endpoint, apiKeyCleared: true });
    await apply(record.value as object);
    expect(resolveLlmSettings((await loadConfig()).llm).apiKey).toBe('');
  });

  it('preserves concurrent sibling fields when an optional object did not exist in the baseline', () => {
    const patch = diffSettings({}, { source: { apiKey: 'draft-key' } });
    expect(applySettingsPatch({ source: { enabled: true } }, patch)).toEqual({ source: { enabled: true, apiKey: 'draft-key' } });
  });

  it('merges all locally touched domain memberships when a handoff reverses an unacknowledged edit', () => {
    const before = { judge: { blockedDomains: ['keep.example'] } };
    const pending = { judge: { blockedDomains: ['outgoing.example'] } };
    const latest = { judge: { blockedDomains: ['keep.example', 'latest.example'] } };
    const patches = diffSettingsFromBaselines([before, pending], latest);
    for (const prior of [before, pending]) {
      const current = { judge: { blockedDomains: [...prior.judge.blockedDomains, 'external.example'] } };
      expect(new Set(applySettingsPatch(current, patches).judge.blockedDomains)).toEqual(new Set(['keep.example', 'latest.example', 'external.example']));
    }
  });

  it.each([false, true])('persists a handed-off draft without waiting for page replies, older write failure=%s', async (failOlder) => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    storage.set.mockImplementationOnce(async (patch) => {
      await paused;
      if (failOlder) throw new Error('older write failed');
      Object.assign(storage.value, structuredClone(patch));
    });
    const baseline = { config: await loadConfig(), bridge: structuredClone(DEFAULT_BRIDGE) };
    const first = structuredClone(baseline);
    first.config.summary.enabled = !baseline.config.summary.enabled;
    first.config.sources.google!.enabled = false;
    const latest = structuredClone(first);
    latest.config.summary.enabled = baseline.config.summary.enabled;
    const pendingCalls: Promise<void>[] = [];
    const queue = createAutosaveQueue<typeof baseline>((value, superseded) => {
      // Background receives the request, but this page never receives any response (as after teardown).
      pendingCalls.push(saveSettings(value, baseline, superseded).catch(() => {}));
      return new Promise<void>(() => {});
    }, vi.fn(), 500);
    queue.observe(baseline);
    queue.observe(first);
    void queue.flush();
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalledTimes(1));
    const concurrentDomain = updateDomainPreference('block', 'external.example');
    queue.observe(latest);
    void queue.handoff();
    queue.dispose();
    expect(storage.send).toHaveBeenCalledTimes(3);
    // The latest request has already reached the background even though the old one is still blocked.
    expect(storage.set).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([...pendingCalls, concurrentDomain]);
    const saved = await loadConfig();
    expect(saved.summary.enabled).toBe(baseline.config.summary.enabled);
    expect(saved.sources.google?.enabled).toBe(false);
    expect(saved.judge.blockedDomains).toContain('external.example');
  });
});
