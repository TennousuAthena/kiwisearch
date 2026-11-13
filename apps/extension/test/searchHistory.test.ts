import { describe, expect, it } from 'vitest';
import { createSnapshotCache, rememberQuery, suggestQueries } from '../lib/searchHistory';

describe('tab-only search history', () => {
  it('keeps distinct history entries for the same query and evicts old snapshots', () => {
    const cache = createSnapshotCache<{ query: string; scroll: number }>(2);
    cache.put('entry-a', { query: 'kiwi', scroll: 300 });
    cache.put('entry-b', { query: 'kiwi', scroll: 700 });
    expect(cache.get('entry-a')?.scroll).toBe(300);
    cache.put('entry-c', { query: 'bird', scroll: 0 });
    expect(cache.get('entry-a')).toBeUndefined();
    expect(cache.get('entry-b')?.scroll).toBe(700);
    expect(cache.size).toBe(2);
  });
  it('updates an entry without duplicating it and preserves recently saved pages', () => {
    const cache = createSnapshotCache<number>(2);
    cache.put('a', 1); cache.put('b', 2); cache.put('a', 3); cache.put('c', 4);
    expect(cache.get('a')).toBe(3); expect(cache.get('b')).toBeUndefined();
  });
  it('suggests only submitted queries, deduplicates and bounds memory', () => {
    let queries = rememberQuery(['Kiwi', 'brave'], ' kiwi ');
    expect(queries).toEqual(['kiwi', 'brave']);
    queries = rememberQuery(queries, '');
    expect(suggestQueries(queries, 'KI')).toEqual(['kiwi']);
    for (let i = 0; i < 20; i++) queries = rememberQuery(queries, `query ${i}`);
    expect(queries).toHaveLength(12);
    expect(suggestQueries(queries, '')).toHaveLength(6);
    expect(suggestQueries(queries, 'not submitted')).toEqual([]);
  });
});
