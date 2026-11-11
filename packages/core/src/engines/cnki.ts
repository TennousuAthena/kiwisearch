import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText, parseCount } from './shared';

/**
 * CNKI (中国知网), the new `kns8s` search. Titles, authors, journal, date and citation counts are public; downloads need an
 * institution or an account, which Kiwi has no part in.
 *
 * VERIFIED against a real page: only the captcha. A clean headless profile was sent from the search address to
 * `/verify/home?captchaType=blockPuzzle` (a slider puzzle), twice, so that address and `.verifybox` are real (cnki-blocked.html).
 * NOT verified: the result table. It could not be captured past the captcha, and `extract` follows the kns8s list markup
 * as remembered (`table.result-table-list`, one `tr` per paper with `td.name`, `td.author`, `td.source`, `td.date`, `td.data`,
 * `td.quote`; fixtures/cnki.html is hand-written to that shape). The list view carries no abstract; `.abstract` is read only if present.
 * A signed-in or on-campus browser may get through without the captcha, and may show a different table: check there first.
 */
export const cnki: BrowserEngine = {
  id: 'cnki',
  label: '知网',
  modes: ['academic'],
  buildUrl: (query) => `https://kns.cnki.net/kns8s/defaultresult/index?korder=SU&kw=${encodeURIComponent(query)}`,
  matches: ['*://kns.cnki.net/kns8s/*', '*://kns.cnki.net/verify/*'],
  readySelector: '.result-table-list td.name a',
  blockedSelector: '.verifybox, .verify-img-out',
  isBlockedUrl: (url) => {
    const { hostname, pathname } = new URL(url);
    return /(^|\.)cnki\.net$/i.test(hostname) && /^\/verify\//.test(pathname);
  },
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const row of doc.querySelectorAll('.result-table-list tbody tr')) {
      const link = row.querySelector('td.name a');
      const url = absoluteHttpUrl(link?.getAttribute('href'), pageUrl);
      const title = cleanText(link);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      const linked = Array.from(row.querySelectorAll('td.author a')).map(cleanText).filter(Boolean);
      const authors = linked.length
        ? linked
        : cleanText(row.querySelector('td.author')).split(/[;；,，、\s]+/).filter(Boolean);
      const venue = cleanText(row.querySelector('td.source')) || undefined;
      const date = cleanText(row.querySelector('td.date')).match(/\d{4}(?:-\d{2}-\d{2})?/)?.[0];
      const type = cleanText(row.querySelector('td.data'));
      const citations = parseCount(cleanText(row.querySelector('td.quote')));
      const abstract = cleanText(row.querySelector('.abstract'));
      const year = date ? Number(date.slice(0, 4)) : undefined;
      const byline = [type, authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' 等' : ''), venue, year].filter(Boolean).join(' · ');
      hits.push({
        url,
        title,
        snippet: [byline, abstract].filter(Boolean).join(' — '),
        content: abstract || undefined,
        rank: hits.length + 1,
        publishedAt: date && date.length === 10 ? date : undefined,
        meta: {
          ...(authors.length ? { authors } : {}),
          ...(venue ? { venue } : {}),
          ...(year ? { year } : {}),
          ...(citations !== undefined ? { citations } : {}),
        },
      });
    }
    return hits;
  },
};
