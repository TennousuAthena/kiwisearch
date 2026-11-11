import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

function resultUrl(href: string, pageUrl: string): string | null {
  const absolute = absoluteHttpUrl(href, pageUrl);
  if (!absolute) return null;
  try {
    const parsed = new URL(absolute);
    if (parsed.pathname === '/l/') return absoluteHttpUrl(parsed.searchParams.get('uddg'), pageUrl);
  } catch {
    return null;
  }
  return absolute;
}

/** A dated snippet is `<span><span>Jun 8, 2026</span><span>text…</span></span>`; joined plainly the date runs into the text, so it is read as "date — text". */
function snippetText(holder: Element | null): string {
  const parts = Array.from(holder?.querySelector('span')?.children ?? [])
    .map(cleanText)
    .filter(Boolean);
  if (parts.length === 2 && parts[0].length <= 24 && /\d/.test(parts[0])) return `${parts[0]} — ${parts[1]}`;
  return cleanText(holder);
}

export const duckduckgo: BrowserEngine = {
  id: 'duckduckgo',
  label: 'DuckDuckGo',
  modes: ['web'],
  buildUrl: (query, count) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`,
  matches: ['*://duckduckgo.com/*', '*://*.duckduckgo.com/*', '*://duckduckgo.com/anomaly.js*'],
  readySelector: 'article[data-testid="result"], [data-testid="results"]',
  blockedSelector: '[data-testid="anomaly-modal"], form[action*="anomaly"], #challenge-form',
  isBlockedUrl: (url) => /\/anomaly(?:\.js)?(?:\/|$)/i.test(new URL(url).pathname),
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    for (const item of doc.querySelectorAll('article[data-testid="result"], .result')) {
      if (item.classList.contains('result--ad')) continue;
      const anchor = item.querySelector('h2 a, a[data-testid="result-title-a"], a.result__a');
      const href = anchor?.getAttribute('href');
      const url = href ? resultUrl(href, pageUrl) : null;
      const title = cleanText(anchor);
      if (!url || !title || url.includes('duckduckgo.com/')) continue;
      // The snippet's marker has changed over time: `data-result="snippet"` on the current page, the others on older ones.
      const snippet = snippetText(item.querySelector('[data-result="snippet"], [data-testid="result-snippet"], .result__snippet'));
      hits.push({ url, title, snippet, rank: hits.length + 1 });
    }
    return hits;
  },
};
