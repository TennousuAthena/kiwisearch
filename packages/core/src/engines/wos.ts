import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText, parseCount } from './shared';

const CLARIVATE_LOGIN = /(^|\.)access\.clarivate\.com$/i;

/**
 * Web of Science Core Collection. It works only in a browser that already has access: an institution's IP range, a proxy,
 * or the user's own sign-in. Kiwi has no key or account for it.
 *
 * VERIFIED against a real page: the no-access path. A clean headless profile opening a search address was sent on to
 * `https://access.clarivate.com/login?app=wos&…` (an e-mail sign-in form plus "机构登录", institution sign-in). That page is on
 * another host than the app, so it is in `matches` (otherwise the content script would never run there and the source would
 * wait out its timeout instead of reporting `blocked`) and `isBlockedUrl` recognizes the host (wos-blocked.html).
 * NOT verified, because it needs an account: the search address, and everything in `extract`. `general-summary?query=TS=(…)`
 * is the address form as remembered, and the `app-record` cards and `data-ta` attributes follow the Angular app as remembered.
 * The title link is found by its `/full-record/` path as well, so a changed attribute costs fields, not the result.
 * The page is slow to render, and the content script gives a page 12 s.
 */
export const wos: BrowserEngine = {
  id: 'wos',
  label: 'Web of Science',
  modes: ['academic'],
  buildUrl: (query) => `https://www.webofscience.com/wos/woscc/general-summary?query=${encodeURIComponent(`TS=(${query})`)}`,
  matches: ['*://www.webofscience.com/wos/*', '*://access.clarivate.com/login*'],
  readySelector: 'app-record a[data-ta="summary-record-title-link"], app-record a[href*="/full-record/"]',
  // No access is a login wall (sign in, or pick your institution), not a captcha; no WoS captcha has been seen.
  blockedSelector: ':not(*)',
  loginSelector: 'form[name="loginForm"], form[name="shibbolethLoginForm"], #signIn-btn',
  isLoginUrl: (url) => CLARIVATE_LOGIN.test(new URL(url).hostname),
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const card of doc.querySelectorAll('app-record')) {
      const link = card.querySelector('a[data-ta="summary-record-title-link"], a[href*="/full-record/"]');
      const url = absoluteHttpUrl(link?.getAttribute('href'), pageUrl);
      const title = cleanText(link);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      const authors = Array.from(card.querySelectorAll('[data-ta^="summary-record-author-link"]')).map(cleanText).filter(Boolean);
      const venue = cleanText(card.querySelector('[data-ta="summary-record-source-title"], [data-ta="summary-record-source-title-link"]')) || undefined;
      const year = cleanText(card.querySelector('[data-ta="summary-record-pubyear"], [data-ta="summary-record-pubdate"]')).match(/\b(?:19|20)\d{2}\b/)?.[0];
      const citations = parseCount(cleanText(card.querySelector('[data-ta="stat-number-citation-related-count"]')));
      const abstract = cleanText(card.querySelector('[data-ta="summary-record-abstract"]'));
      const byline = [authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''), venue, year].filter(Boolean).join(' · ');
      hits.push({
        url,
        title,
        snippet: [byline, abstract].filter(Boolean).join(' — '),
        content: abstract || undefined,
        rank: hits.length + 1,
        meta: {
          ...(authors.length ? { authors } : {}),
          ...(venue ? { venue } : {}),
          ...(year ? { year: Number(year) } : {}),
          ...(citations !== undefined ? { citations } : {}),
        },
      });
    }
    return hits;
  },
};
