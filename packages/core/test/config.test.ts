import { describe, expect, it } from 'vitest';
import { CONFIG_VERSION, DEFAULT_CONFIG, mergeConfig, migrateConfig, usableSources } from '../src/config';
import { BROWSER_ENGINES } from '../src/engines';
import { llmUsable } from '../src/llm';

describe('config versioning', () => {
  it('treats an unversioned stored config as current and stamps the version on merge', () => {
    const stored = { llm: { apiKey: '{{SECRET_llmkey01}}' }, sources: { google: { enabled: false } } };
    const migrated = migrateConfig(stored);
    expect(migrated?.version).toBe(CONFIG_VERSION);
    const merged = mergeConfig(DEFAULT_CONFIG, migrated);
    expect(merged.version).toBe(CONFIG_VERSION);
    expect(merged.llm.apiKey).toBe('{{SECRET_llmkey01}}');
    expect(merged.llm.baseUrl).toBe(DEFAULT_CONFIG.llm.baseUrl);
    expect(merged.sources.google?.enabled).toBe(false);
    expect(merged.sources.bing?.enabled).toBe(true);
  });

  it('gives a config stored before block lists existed the defaults, and fills what a partial one leaves out', () => {
    const before = mergeConfig(DEFAULT_CONFIG, migrateConfig({ judge: { blockedDomains: ['a.com'] } }));
    expect(before.judge.blockedDomains).toEqual(['a.com']);
    expect(before.judge.blocklists).toEqual({ recommended: [], subscriptions: [], custom: '' });
    const partial = mergeConfig(DEFAULT_CONFIG, migrateConfig({ judge: { blocklists: { recommended: ['x'] } } }));
    expect(partial.judge.blocklists).toEqual({ recommended: ['x'], subscriptions: [], custom: '' });
  });

  it('does not share the default block lists between configs', () => {
    const merged = mergeConfig(DEFAULT_CONFIG, undefined);
    merged.judge.blocklists.recommended.push('x');
    expect(DEFAULT_CONFIG.judge.blocklists.recommended).toEqual([]);
  });

  it('ignores junk and keeps unknown newer versions readable', () => {
    expect(migrateConfig(undefined)).toBeUndefined();
    expect(migrateConfig('nope')).toBeUndefined();
    expect(mergeConfig(DEFAULT_CONFIG, migrateConfig({ version: 99 })).version).toBe(CONFIG_VERSION);
  });
});

describe('config migration 1 -> 2', () => {
  it('turns off the old captcha-takes-focus default that was saved into stored configs', () => {
    const migrated = migrateConfig({ version: 1, renderer: { minIntervalMs: 5000, workerIdleMinutes: 10, focusOnCaptcha: true } });
    expect(migrated?.renderer).toEqual({ minIntervalMs: 5000, workerIdleMinutes: 10, focusOnCaptcha: false });
    expect(mergeConfig(DEFAULT_CONFIG, migrated).renderer.minIntervalMs).toBe(5000);
  });

  it('also covers a config saved before versions existed, and leaves a version-2 choice alone', () => {
    expect(migrateConfig({ renderer: { focusOnCaptcha: true } })?.renderer?.focusOnCaptcha).toBe(false);
    expect(migrateConfig({ version: 2, renderer: { focusOnCaptcha: true } })?.renderer?.focusOnCaptcha).toBe(true);
    expect(migrateConfig({ version: 1 })?.renderer?.focusOnCaptcha).toBe(false);
    expect(DEFAULT_CONFIG.renderer.focusOnCaptcha).toBe(false);
  });
});

describe('config migration 2 -> 3', () => {
  it('switches Baidu off in stored configs, keeping its other settings and every other source as saved', () => {
    const migrated = migrateConfig({ version: 2, sources: { baidu: { enabled: true, weight: 2 }, google: { enabled: false }, bing: { enabled: true } } });
    expect(migrated?.sources).toEqual({ baidu: { enabled: false, weight: 2 }, google: { enabled: false }, bing: { enabled: true } });
  });

  it('covers older and source-less configs, and leaves a version-3 choice alone', () => {
    expect(migrateConfig({ version: 1, sources: { baidu: { enabled: true } } })?.sources?.baidu?.enabled).toBe(false);
    expect(migrateConfig({ sources: { baidu: { enabled: true } } })?.sources?.baidu?.enabled).toBe(false);
    expect(migrateConfig({ version: 2 })?.sources).toEqual({ baidu: { enabled: false } });
    expect(migrateConfig({ version: 3, sources: { baidu: { enabled: true } } })?.sources?.baidu?.enabled).toBe(true);
  });

  it('is off in a fresh config, so a general search does not use Baidu unless it is turned on', () => {
    expect(DEFAULT_CONFIG.sources.baidu?.enabled).toBe(false);
    const asked = usableSources(DEFAULT_CONFIG, true, 'web').filter((source) => !source.reason).map((source) => source.id);
    expect(asked).not.toContain('baidu');
    const on = structuredClone(DEFAULT_CONFIG);
    on.sources.baidu = { enabled: true };
    expect(usableSources(on, true, 'web').filter((source) => !source.reason).map((source) => source.id)).toContain('baidu');
  });

  it('lists Baidu after every other browser engine', () => {
    expect(Object.keys(BROWSER_ENGINES).at(-1)).toBe('baidu');
  });
});

describe('usableSources', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  const reason = (id: string, mode?: Parameters<typeof usableSources>[2], hasBrowser = true) =>
    usableSources(config, hasBrowser, mode).find((source) => source.id === id)?.reason;

  it('filters by mode', () => {
    expect(reason('scholar', 'academic')).toBeUndefined();
    expect(reason('scholar', 'web')).toMatch(/not available in web/);
    expect(reason('google', 'academic')).toMatch(/not available in academic/);
    expect(reason('google', 'web')).toBeUndefined();
    expect(reason('google')).toBeUndefined();
  });

  it('uses the source declarations for prerequisites', () => {
    expect(reason('google', 'web', false)).toBe('needs browser extension');
    expect(reason('brave', 'web')).toBe('missing API key');
    config.sources.searxng = { enabled: true };
    expect(reason('searxng', 'web')).toBe('missing base URL');
    config.sources.searxng = { enabled: true, baseUrl: 'https://searx.example' };
    expect(reason('searxng', 'web')).toBeUndefined();
  });
});

describe('llmUsable', () => {
  const llm = (baseUrl: string, apiKey = '') => ({ baseUrl, apiKey, model: 'm' });
  it('requires a key for remote endpoints', () => {
    expect(llmUsable(llm('https://api.deepseek.com/v1'))).toBe(false);
    expect(llmUsable(llm('https://api.deepseek.com/v1', '{{SECRET_llmkey01}}'))).toBe(true);
  });
  it('allows keyless local servers', () => {
    expect(llmUsable(llm('http://localhost:11434/v1'))).toBe(true);
    expect(llmUsable(llm('http://127.0.0.1:11434/v1'))).toBe(true);
    expect(llmUsable(llm('http://[::1]:11434/v1'))).toBe(true);
    expect(llmUsable(llm('http://localhost.evil.example/v1'))).toBe(false);
  });
  it('rejects missing or malformed settings', () => {
    expect(llmUsable(undefined)).toBe(false);
    expect(llmUsable({ baseUrl: '', apiKey: 'k', model: 'm' })).toBe(false);
    expect(llmUsable(llm('not a url'))).toBe(false);
  });
});
