import { describe, expect, it } from 'vitest';
import { engineUrl, ENGINES, isEngine, modeFromLocation, queryFromLocation, rememberedEngine, rememberEngine } from '../src/fallback';

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
