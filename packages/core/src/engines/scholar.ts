import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

export const scholar: BrowserEngine = {
  id: 'scholar',
  label: 'Google Scholar',
  modes: ['academic'],
  buildUrl: (query, count) => `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}&num=${Math.min(count, 20)}`,
  matches: ['*://scholar.google.com/scholar*', '*://scholar.google.com/sorry/*'],
  readySelector: '.gs_r.gs_or.gs_scl',
  blockedSelector: '#captcha-form, form[action*="sorry"], [id*="captcha"]',
  isBlockedUrl: (url) => /\/sorry(?:\/|$)|recaptcha/i.test(new URL(url).pathname + new URL(url).search),
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    for (const item of doc.querySelectorAll('.gs_r.gs_or.gs_scl')) {
      const titleNode = item.querySelector('.gs_rt');
      const anchor = titleNode?.querySelector('a');
      const url = absoluteHttpUrl(anchor?.getAttribute('href'), pageUrl);
      const title = cleanText(titleNode);
      if (!url || !title || /(^|\.)google\.com$/i.test(new URL(url).hostname)) continue;
      const byline = cleanText(item.querySelector('.gs_a'));
      const citationsText = cleanText(item.querySelector('.gs_fl'));
      const authorsText = byline.split(/\s+[–-]\s+/)[0] ?? '';
      const authors = authorsText.split(/,\s*/).filter(Boolean);
      const venue = byline.split(/\s+[–-]\s+/)[1]?.replace(/,\s*\d{4}.*$/, '').trim();
      const year = byline.match(/\b(19|20)\d{2}\b/)?.[0];
      const citations = citationsText.match(/Cited by\s+([\d,]+)/i)?.[1]?.replace(/,/g, '');
      const pdfUrl = absoluteHttpUrl(item.querySelector('.gs_or_ggsm a')?.getAttribute('href'), pageUrl) ?? undefined;
      hits.push({
        url,
        title,
        snippet: cleanText(item.querySelector('.gs_rs')),
        rank: hits.length + 1,
        meta: {
          ...(authors.length ? { authors } : {}),
          ...(venue ? { venue } : {}),
          ...(year ? { year: Number(year) } : {}),
          ...(citations ? { citations: Number(citations) } : {}),
          ...(pdfUrl ? { pdfUrl } : {}),
        },
      });
    }
    return hits;
  },
};
