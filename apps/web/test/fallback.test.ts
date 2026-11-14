import { describe, expect, it, vi } from 'vitest';
import { engineUrl, ENGINES, isEngine, modeFromLocation, queryFromLocation, redirectToRememberedEngine, rememberedEngine, rememberEngine, safeStorage } from '../src/fallback';

const memory = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); }, data }; };

describe('other engines', () => {
  it('builds each engine address with the query fully escaped', () => {
    expect(engineUrl('google', 'a&b c')).toBe('https://www.google.com/search?q=a%26b%20c');
    expect(engineUrl('baidu', '你好')).toBe('https://www.baidu.com/s?wd=%E4%BD%A0%E5%A5%BD');
    expect(ENGINES.map((e) => e.id)).toEqual(['google', 'bing', 'duckduckgo', 'baidu']);
  });

  it('remembers one engine on this device and forgets it', () => {
    const store = memory();
    expect(rememberedEngine(store)).toBeNull();
    rememberEngine(store, 'bing');
    expect(rememberedEngine(store)).toBe('bing');
    rememberEngine(store, null);
    expect(rememberedEngine(store)).toBeNull();
  });

  it('ignores a stored value that is not an engine, and a store that throws', () => {
    const store = memory(); store.setItem('kiwi:fallbackEngine', 'evil.example');
    expect(rememberedEngine(store)).toBeNull();
    const broken = { getItem: () => { throw new Error('off'); }, setItem: () => { throw new Error('off'); }, removeItem: () => { throw new Error('off'); } };
    expect(rememberedEngine(broken)).toBeNull();
    expect(() => rememberEngine(broken, 'google')).not.toThrow();
    expect(isEngine('google')).toBe(true);
    expect(isEngine('evil.example')).toBe(false);
  });

  it('reads the query and mode from either form of the address', () => {
    expect(queryFromLocation({ search: '', hash: '#m=news&q=hello%20world' })).toBe('hello world');
    expect(queryFromLocation({ search: '?q=old', hash: '' })).toBe('old');
    expect(queryFromLocation({ search: '', hash: '' })).toBe('');
    expect(modeFromLocation({ search: '', hash: '#m=images&q=x' })).toBe('images');
    expect(modeFromLocation({ search: '', hash: '#q=x' })).toBe('web');
  });
});

describe('storage the browser blocks', () => {
  const blocked = () => { const win = {} as { localStorage?: Storage }; Object.defineProperty(win, 'localStorage', { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); } }); return win; };

  it('does not break the page: naming `localStorage` is what throws, and an inert store stands in', () => {
    const store = safeStorage(blocked());
    expect(rememberedEngine(store)).toBeNull();
    expect(() => rememberEngine(store, 'google')).not.toThrow();
    expect(rememberedEngine(store)).toBeNull();
  });

  it('is the real storage when it works', () => {
    const real = memory();
    expect(safeStorage({ localStorage: real as unknown as Storage })).toBe(real);
  });
});

describe('sending the user to the engine they chose', () => {
  it('does so for a missing or silent extension, with the query escaped, and for nothing else', () => {
    const store = memory(); rememberEngine(store, 'bing');
    for (const [state, expected] of [['missing', true], ['unavailable', true], ['incompatible', false], ['disabled', false], ['stale', false]] as const) {
      const go = vi.fn();
      expect(redirectToRememberedEngine(state, 'a&b c', store, go), state).toBe(expected);
      if (expected) expect(go).toHaveBeenCalledWith('https://www.bing.com/search?q=a%26b%20c');
      else expect(go).not.toHaveBeenCalled();
    }
  });

  it('does nothing without a remembered engine or without a query', () => {
    const go = vi.fn();
    expect(redirectToRememberedEngine('missing', 'x', memory(), go)).toBe(false);
    const store = memory(); rememberEngine(store, 'google');
    expect(redirectToRememberedEngine('missing', '   ', store, go)).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });
});
