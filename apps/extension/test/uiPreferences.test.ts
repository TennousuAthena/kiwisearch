import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), listen: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { storage: { local: { get: storage.get, set: storage.set }, onChanged: { addListener: storage.listen } } } }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  storage.get.mockResolvedValue({}); storage.set.mockResolvedValue(undefined);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn() }));
});
describe('independent UI preferences', () => {
  it('validates saved values without changing legacy config', async () => {
    const { readUiPreferences } = await import('../lib/uiPreferences');
    expect(readUiPreferences({ 'ui:theme': 'unknown', 'ui:summaryMode': 'on-demand', 'ui:openNewTab': false, config: { secret: 'test' } }))
      .toEqual({ theme: 'system', summaryMode: 'on-demand', openNewTab: false, recentQueries: true });
  });

  it('reads a legacy disabled overview as off until an explicit UI mode is selected', async () => {
    const { readUiPreferences } = await import('../lib/uiPreferences');
    expect(readUiPreferences({ config: { summary: { enabled: false } } }).summaryMode).toBe('off');
    expect(readUiPreferences({ config: { summary: { enabled: true } } }).summaryMode).toBe('auto');
    expect(readUiPreferences({}).summaryMode).toBe('auto');
    expect(readUiPreferences({ config: { summary: null } }).summaryMode).toBe('auto');
    expect(readUiPreferences({ 'ui:summaryMode': 'invalid', config: { summary: { enabled: false } } }).summaryMode).toBe('off');
    for (const mode of ['auto', 'on-demand', 'off']) {
      expect(readUiPreferences({ 'ui:summaryMode': mode, config: { summary: { enabled: false } } }).summaryMode).toBe(mode);
    }
  });

  it('loads compatibility values without persisting a migration or rewriting config', async () => {
    storage.get.mockResolvedValue({ config: { summary: { enabled: false }, llm: { apiKey: 'test-only' } } });
    const { initializeUiPreferences, getUiPreferences } = await import('../lib/uiPreferences');
    await initializeUiPreferences();
    expect(storage.get).toHaveBeenCalledWith(['ui:theme', 'ui:summaryMode', 'ui:openNewTab', 'ui:recentQueries', 'config']);
    expect(getUiPreferences().summaryMode).toBe('off'); expect(storage.set).not.toHaveBeenCalled();
  });
  it('writes separate fields and never writes queries, keys or config', async () => {
    const { updateUiPreferences } = await import('../lib/uiPreferences');
    await Promise.all([updateUiPreferences({ theme: 'light' }), updateUiPreferences({ summaryMode: 'off' })]);
    expect(storage.set.mock.calls.map((call) => call[0])).toEqual([{ 'ui:theme': 'light' }, { 'ui:summaryMode': 'off' }]);
  });
  it('allows read and write failures to be retried', async () => {
    const { initializeUiPreferences, updateUiPreferences } = await import('../lib/uiPreferences');
    storage.get.mockRejectedValueOnce(new Error('read failed'));
    await expect(initializeUiPreferences()).rejects.toThrow('read failed');
    await initializeUiPreferences();
    storage.set.mockRejectedValueOnce(new Error('write failed'));
    await expect(updateUiPreferences({ theme: 'dark' })).rejects.toThrow('write failed');
    await updateUiPreferences({ theme: 'dark' });
    expect(storage.set).toHaveBeenCalledTimes(2);
  });

  it('shares explicit modes across pages while config changes only affect the legacy fallback', async () => {
    storage.get.mockResolvedValue({ config: { summary: { enabled: false } } });
    const first = await import('../lib/uiPreferences'); await first.initializeUiPreferences();
    vi.resetModules();
    const second = await import('../lib/uiPreferences'); await second.initializeUiPreferences();
    const emit = (changes: Record<string, { newValue?: unknown }>, area = 'local') => storage.listen.mock.calls.forEach(([listener]) => listener(changes, area));
    storage.set.mockImplementation(async (values) => emit(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]))));
    expect(first.getUiPreferences().summaryMode).toBe('off'); expect(second.getUiPreferences().summaryMode).toBe('off');
    emit({ config: { newValue: { summary: { enabled: true } } } });
    expect(first.getUiPreferences().summaryMode).toBe('auto'); expect(second.getUiPreferences().summaryMode).toBe('auto');
    emit({ config: { newValue: { summary: { enabled: false } } } });
    await first.updateUiPreferences({ summaryMode: 'auto' });
    expect(second.getUiPreferences().summaryMode).toBe('auto');
    emit({ config: { newValue: { summary: { enabled: false } } }, 'ui:theme': { newValue: 'dark' } });
    expect(first.getUiPreferences()).toMatchObject({ summaryMode: 'auto', theme: 'dark' });
    await second.updateUiPreferences({ summaryMode: 'on-demand' });
    expect(first.getUiPreferences().summaryMode).toBe('on-demand');
    emit({ 'ui:summaryMode': {} });
    expect(first.getUiPreferences().summaryMode).toBe('off'); expect(second.getUiPreferences().summaryMode).toBe('off');
    emit({ 'ui:summaryMode': { newValue: 'auto' } }, 'sync');
    expect(first.getUiPreferences().summaryMode).toBe('off');
    expect(storage.set.mock.calls.map(([values]) => values)).toEqual([{ 'ui:summaryMode': 'auto' }, { 'ui:summaryMode': 'on-demand' }]);
  });

  it('keeps storage changes arriving during initialization instead of the stale read', async () => {
    let resolveRead!: (values: Record<string, unknown>) => void;
    storage.get.mockImplementation(() => new Promise((resolve) => { resolveRead = resolve; }));
    const { initializeUiPreferences, getUiPreferences } = await import('../lib/uiPreferences');
    const loading = initializeUiPreferences();
    storage.listen.mock.calls[0][0]({ 'ui:summaryMode': { newValue: 'auto' }, config: { newValue: { summary: { enabled: false } } } }, 'local');
    resolveRead({ config: { summary: { enabled: false } } }); await loading;
    expect(getUiPreferences().summaryMode).toBe('auto'); expect(storage.set).not.toHaveBeenCalled();
  });

  it('does not replay a slow local write over a newer storage change from another page', async () => {
    let resolveWrite!: () => void;
    storage.set.mockImplementation(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    const { initializeUiPreferences, updateUiPreferences, getUiPreferences } = await import('../lib/uiPreferences');
    await initializeUiPreferences(); const saving = updateUiPreferences({ summaryMode: 'off' });
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalled());
    const changed = storage.listen.mock.calls[0][0];
    changed({ 'ui:summaryMode': { newValue: 'off' } }, 'local');
    changed({ 'ui:summaryMode': { newValue: 'on-demand' } }, 'local');
    resolveWrite(); await saving;
    expect(getUiPreferences().summaryMode).toBe('on-demand');
  });
});
