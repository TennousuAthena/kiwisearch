import { describe, expect, it } from 'vitest';
import { createSourceCache } from '../src/cache';
import type { SearchHit } from '../src/types';

const hit = (url: string): SearchHit => ({ source: 'google', url, title: url, snippet: '', rank: 1 });

describe('createSourceCache', () => {
  it('returns copies so callers cannot mutate cached entries', () => {
    const cache = createSourceCache();
    cache.set('k', [hit('https://a.example')]);
    cache.get('k')![0].title = 'changed';
    expect(cache.get('k')![0].title).toBe('https://a.example');
  });

  it('expires entries after the TTL', () => {
    let now = 1000;
    const cache = createSourceCache(100, 10, () => now);
    cache.set('k', [hit('https://a.example')]);
    now += 99;
    expect(cache.get('k')).toBeDefined();
    now += 2;
    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the oldest entry beyond the size limit', () => {
    const cache = createSourceCache(1000, 2);
    cache.set('a', [hit('https://a.example')]);
    cache.set('b', [hit('https://b.example')]);
    cache.set('c', [hit('https://c.example')]);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });
});
