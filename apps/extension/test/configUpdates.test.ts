import { DEFAULT_CONFIG } from '@kiwi-search/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ value: {} as Record<string, unknown>, get: vi.fn(), set: vi.fn(), send: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { storage: { local: { get: storage.get, set: storage.set } }, runtime: { sendMessage: storage.send } } }));
import { handleConfigUpdate } from '../lib/backgroundConfig';
import { applySettingsPatch, diffSettings, diffSettingsFromBaselines, undoDomainPreference, updateDomainPreference } from '../lib/configUpdates';
import { DEFAULT_BRIDGE, loadConfig, saveConfig, saveSettings } from '../lib/settings';
import { createAutosaveQueue } from '../entrypoints/options/autosaveQueue';

beforeEach(() => {
  storage.value = { config: structuredClone(DEFAULT_CONFIG) };
  storage.get.mockReset().mockImplementation(async () => structuredClone(storage.value));
  storage.set.mockReset().mockImplementation(async (patch) => { Object.assign(storage.value, structuredClone(patch)); });
  storage.send.mockReset().mockImplementation(handleConfigUpdate);
});

describe('settings writes from multiple pages', () => {
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
