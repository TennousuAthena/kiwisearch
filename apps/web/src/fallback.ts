import { readPageParams } from '@kiwi-search/app/pageLocation';

/** The engines offered when the page cannot search by itself. A click sends the query to that engine: the user chose it, nothing is sent before. */
export const ENGINES = [
  { id: 'google', url: (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  { id: 'bing', url: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { id: 'duckduckgo', url: (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
  { id: 'baidu', url: (q: string) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}` },
] as const;
export type EngineId = (typeof ENGINES)[number]['id'];

const KEY = 'kiwi:fallbackEngine';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const isEngine = (value: unknown): value is EngineId => ENGINES.some((engine) => engine.id === value);

/** The engine the user asked to be sent to from now on, kept on this device only. */
export function rememberedEngine(store: Store): EngineId | null {
  try {
    const value = store.getItem(KEY);
    return isEngine(value) ? value : null;
  } catch { return null; }
}
export function rememberEngine(store: Store, engine: EngineId | null): void {
  try { if (engine) store.setItem(KEY, engine); else store.removeItem(KEY); } catch { /* storage is off: nothing is remembered */ }
}

export const engineUrl = (engine: EngineId, query: string): string => ENGINES.find((e) => e.id === engine)!.url(query);

/** The query in the page's address, from either form of it. */
export const queryFromLocation = (location: { search: string; hash: string }): string => readPageParams(location).get('q') ?? '';

export function modeFromLocation(location: { search: string; hash: string }): string {
  return readPageParams(location).get('m') ?? 'web';
}
