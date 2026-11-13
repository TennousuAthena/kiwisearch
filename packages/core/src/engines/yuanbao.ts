import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

/** Read the site's semantic link roles instead of its generated CSS-module names. */
function findLink(card: Element, ...roles: string[]): Element | undefined {
  for (const link of card.querySelectorAll('a[data-log]')) {
    try {
      const log: unknown = JSON.parse(link.getAttribute('data-log') ?? '');
      if (log && typeof log === 'object' && 'linkid' in log && typeof log.linkid === 'string' && roles.includes(log.linkid)) return link;
    } catch {
      // A malformed analytics attribute is page data, not executable code.
    }
  }
  return undefined;
}

/** Yuanbao's ordinary web results; AI chat, related searches and card sublinks are not search hits. */
export const yuanbao: BrowserEngine = {
  id: 'yuanbao',
  label: '元宝搜索',
  modes: ['web'],
  buildUrl: (query) => `https://so.qq.com/isearch?query=${encodeURIComponent(query)}&quick=1`,
  matches: ['*://so.qq.com/isearch*'],
  readySelector: '.result-card a[data-log*="title"]',
  // Ordinary results were available signed out; no verification page has been observed.
  blockedSelector: ':not(*)',
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const card of doc.querySelectorAll('.result-card')) {
      const heading = findLink(card, 'title', 'header_title');
      const title = cleanText(heading);
      const url = absoluteHttpUrl(heading?.getAttribute('href'), pageUrl);
      if (!url || !title || seen.has(url) || new URL(url).hostname === 'so.qq.com') continue;
      seen.add(url);
      const snippet = cleanText(findLink(card, 'summary', 'description')).slice(0, 300);
      hits.push({ url, title, snippet, rank: hits.length + 1 });
    }
    return hits;
  },
};
