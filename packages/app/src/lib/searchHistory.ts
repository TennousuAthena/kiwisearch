export interface ReadingPosition { y: number; key?: string; offset?: number }

/** Bounded tab-memory snapshots; never writes queries or results to storage. */
export function createSnapshotCache<T>(limit = 12) {
  const entries = new Map<string, T>();
  return {
    put(key: string, value: T) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
    get(key: string) { return entries.get(key); },
    get size() { return entries.size; },
  };
}

export function rememberQuery(queries: string[], query: string): string[] {
  const q = query.trim().slice(0, 500);
  if (!q) return queries;
  return [q, ...queries.filter((item) => item.toLocaleLowerCase() !== q.toLocaleLowerCase())].slice(0, 12);
}

export function suggestQueries(queries: string[], draft: string): string[] {
  const q = draft.trim().toLocaleLowerCase();
  return queries.filter((item) => !q || item.toLocaleLowerCase().includes(q)).slice(0, 6);
}

export function captureReadingPosition(): ReadingPosition {
  const y = window.scrollY;
  if (y < 160) return { y };
  for (const row of document.querySelectorAll<HTMLElement>('[data-result-key]')) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > 80 && rect.top < innerHeight) return { y, key: row.dataset.resultKey, offset: rect.top };
  }
  return { y };
}

export function restoreReadingPosition(position: ReadingPosition) {
  const row = position.key ? Array.from(document.querySelectorAll<HTMLElement>('[data-result-key]')).find((item) => item.dataset.resultKey === position.key) : undefined;
  const top = row && position.offset !== undefined ? window.scrollY + row.getBoundingClientRect().top - position.offset : position.y;
  window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
}
