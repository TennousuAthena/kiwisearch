import type { BrowserEngine, SearchHit, SearchSource, SourceId } from '../types';

/** Elements whose text is code or markup for the browser, never something the page shows. Google puts an inline script inside a snippet. */
const NOT_VISIBLE_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

function collectText(node: Node, out: string[]): void {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out.push(child.nodeValue ?? '');
    else if (child.nodeType === 1 && !NOT_VISIBLE_TEXT.has((child as Element).tagName.toUpperCase())) collectText(child, out);
  }
}

/** The text a reader sees in `node`, on one line. `textContent` would also return the code of any `<script>` or `<style>` inside it. */
export function cleanText(node: Element | null | undefined): string {
  if (!node) return '';
  const parts: string[] = [];
  collectText(node, parts);
  return parts.join('').replace(/\s+/g, ' ').trim();
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
    modes: engine.modes,
    requiresKey: false,
    requiresBrowser: true,
    async search(query, { env, mode, count, signal, onBlocked, onStart, renderer }) {
      if (!env.runBrowserEngine) throw new Error(`${engine.label} needs the browser extension`);
      const hits = await env.runBrowserEngine(engine, query, { mode, count, signal, onBlocked, onStart, renderer });
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

export type BrowserEngineId = Extract<SourceId, 'google' | 'bing' | 'baidu' | 'baiduxueshu' | 'cnki' | 'wos' | 'duckduckgo' | 'bravesearch' | 'scholar' | 'yandex' | 'youtube' | 'bilibili' | 'zhihu' | 'xiaohongshu' | 'rednote' | 'sogou' | 'weixin' | 'x'>;

/** "423", "8,485", "1.2 万", "10万+", "1.2K" → a number. Platforms print counts in their own style, so this is only for sorting and thresholds. */
export function parseCount(raw: string | null | undefined): number | undefined {
  const match = raw?.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([万千亿kKwW])?/);
  if (!match) return undefined;
  const units: Record<string, number> = { 万: 1e4, w: 1e4, W: 1e4, 千: 1e3, k: 1e3, K: 1e3, 亿: 1e8 };
  return Math.round(Number(match[1]) * (units[match[2] ?? ''] ?? 1));
}
