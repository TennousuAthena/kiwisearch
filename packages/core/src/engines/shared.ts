import type { BrowserEngine, SearchHit, SearchSource, SourceId } from '../types';

export function cleanText(node: Element | null | undefined): string {
  return node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

export function absoluteHttpUrl(raw: string | null | undefined, baseUrl: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, baseUrl);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function makeBrowserSource(engine: BrowserEngine): SearchSource {
  return {
    id: engine.id,
    label: engine.label,
    kind: engine.kind,
    requiresKey: false,
    requiresBrowser: true,
    async search(query, { env, count, signal, onBlocked }) {
      if (!env.runBrowserEngine) throw new Error(`${engine.label} needs the browser extension`);
      const hits = await env.runBrowserEngine(engine, query, { count, signal, onBlocked });
      const resolved = engine.resolve ? await engine.resolve(hits, { fetch: env.fetch, signal }) : hits;
      return resolved.slice(0, count).map((hit, index): SearchHit => ({ ...hit, source: engine.id, rank: index + 1 }));
    },
  };
}

export function isEngineUrl(engine: BrowserEngine, url: string, ...hostnames: string[]): boolean {
  try {
    const parsed = new URL(url);
    const hostMatches = hostnames.some((hostname) => parsed.hostname === hostname || parsed.hostname.endsWith(`.${hostname}`));
    return hostMatches && !!engine.isBlockedUrl?.(url);
  } catch {
    return false;
  }
}

export type BrowserEngineId = Extract<SourceId, 'google' | 'bing' | 'baidu' | 'duckduckgo' | 'scholar' | 'yandex'>;
