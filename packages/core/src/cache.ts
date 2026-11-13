import type { SearchHit, SourceCache } from './types';

/** In-memory TTL cache; the oldest entry goes first once `max` is reached. */
export function createSourceCache(ttlMs = 5 * 60_000, max = 200, now: () => number = Date.now): SourceCache {
  const entries = new Map<string, { at: number; ttlMs: number; hits: SearchHit[] }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at >= entry.ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return structuredClone(entry.hits);
    },
    set(key, hits, entryTtlMs = ttlMs) {
      entries.delete(key);
      entries.set(key, { at: now(), ttlMs: entryTtlMs, hits: structuredClone(hits) });
      if (entries.size > max) entries.delete(entries.keys().next().value as string);
    },
  };
}
