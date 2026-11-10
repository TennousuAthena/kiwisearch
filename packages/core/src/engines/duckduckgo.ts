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

export const duckduckgo: BrowserEngine = {
  id: 'duckduckgo',
  label: 'DuckDuckGo',
  kind: 'web',
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
      const snippet = cleanText(item.querySelector('[data-testid="result-snippet"], .result__snippet'));
      hits.push({ url, title, snippet, rank: hits.length + 1 });
    }
    return hits;
  },
};
