import type { BrowserEngine } from '../types';
import { doiFromUrl } from '../url';
import { absoluteHttpUrl, cleanText } from './shared';

const WAPPASS = /(^|\.)wappass\.baidu\.com$/i;

/**
 * Baidu Scholar (百度学术). `/s?wd=` hands over to the single-page app at `/ndscholar/browse/search`, which draws the cards
 * (`div.paper-wrap.result`); both addresses are matched so the content script is there before and after.
 * Result links are Baidu Scholar's own detail pages (`/usercenter/paper/show?paperid=…`), not redirects, and the list shows no DOI.
 * A client Baidu doubts gets "百度安全验证" (a click-the-characters captcha) at the *same* address, so the URL can't tell: the
 * captcha library's own script and style files do. Opening the site's home page first got past it in a clean headless profile.
 */
export const baiduxueshu: BrowserEngine = {
  id: 'baiduxueshu',
  label: '百度学术',
  modes: ['academic'],
  buildUrl: (query) => `https://xueshu.baidu.com/s?wd=${encodeURIComponent(query)}&ie=utf-8&tn=SE_baiduxueshu_c1gjeupa`,
  matches: ['*://xueshu.baidu.com/s*', '*://xueshu.baidu.com/ndscholar/*'],
  readySelector: 'div.paper-wrap.result h3.paper-title a',
  blockedSelector: 'script[src*="BiocFacade"], script[src*="bfe_captcha"], link[href*="BiocCaptcha"]',
  // Baidu's older checks send people to wappass.baidu.com; the xueshu captcha itself did not redirect.
  isBlockedUrl: (url) => WAPPASS.test(new URL(url).hostname),
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const card of doc.querySelectorAll('div.paper-wrap.result')) {
      const link = card.querySelector('h3.paper-title a');
      const url = absoluteHttpUrl(link?.getAttribute('href'), pageUrl);
      const title = cleanText(link);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      // The byline is a row of spans: type, authors (links to an author search), journal or publisher, "被引量：n", "- 2014年".
      const authors: string[] = [];
      let venue: string | undefined;
      let year: number | undefined;
      let citations: number | undefined;
      const info = card.querySelector('.paper-info');
      const type = cleanText(info?.querySelector('.paper-type'));
      for (const part of Array.from(info?.children ?? [])) {
        if (part.classList.contains('paper-type')) continue;
        const text = cleanText(part);
        if (!text) continue;
        const cited = text.match(/被引量[:：]\s*([\d,]+)/);
        const dated = text.match(/^-?\s*((?:19|20)\d{2})\s*年?$/);
        if (cited) citations = Number(cited[1].replace(/,/g, ''));
        else if (dated) year = Number(dated[1]);
        else if (part.querySelector('a[href*="author"]')) {
          // Authors are separated by full-width or ASCII commas, one span each or several in one.
          authors.push(...text.split(/[,，、;；]/).map((name) => name.trim()).filter(Boolean));
        } else venue ??= text.replace(/^《(.*)》$/, '$1');
      }
      const abstract = cleanText(card.querySelector('.paper-abstract'));
      // No DOI is printed in the list; one is only taken from a source link that carries it.
      const doi = Array.from(card.querySelectorAll('.paper-source a[href]'))
        .map((anchor) => doiFromUrl(anchor.getAttribute('href') ?? ''))
        .find(Boolean);
      const byline = [type, authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' 等' : ''), venue, year].filter(Boolean).join(' · ');
      hits.push({
        url,
        title,
        snippet: [byline, abstract].filter(Boolean).join(' — '),
        content: abstract || undefined,
        rank: hits.length + 1,
        meta: {
          ...(authors.length ? { authors } : {}),
          ...(venue ? { venue } : {}),
          ...(year ? { year } : {}),
          ...(citations !== undefined ? { citations } : {}),
          ...(doi ? { doi } : {}),
        },
      });
    }
    return hits;
  },
};
