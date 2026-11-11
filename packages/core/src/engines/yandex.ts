import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

export const yandex: BrowserEngine = {
  id: 'yandex',
  label: 'Yandex',
  kind: 'web',
  buildUrl: (query, count) => `https://yandex.com/search/?text=${encodeURIComponent(query)}&numdoc=${Math.min(count, 50)}`,
  matches: ['*://*.yandex.com/search*', '*://*.yandex.ru/search*', '*://*.yandex.com/showcaptcha*', '*://*.yandex.ru/showcaptcha*'],
  readySelector: 'li.serp-item',
  blockedSelector: '.CheckboxCaptcha, .AdvancedCaptcha, [class*="captcha"]',
  isBlockedUrl: (url) => /showcaptcha/i.test(new URL(url).pathname),
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    for (const item of doc.querySelectorAll('li.serp-item')) {
      const anchor = item.querySelector('a.OrganicTitle-Link, a.Link.organic__url, h2 a');
      const url = absoluteHttpUrl(anchor?.getAttribute('href'), pageUrl);
      const title = cleanText(item.querySelector('.OrganicTitle-LinkText, h2') ?? anchor);
      if (!url || !title || /(^|\.)yandex\.[a-z.]+$/i.test(new URL(url).hostname)) continue;
      hits.push({
        url,
        title,
        snippet: cleanText(item.querySelector('.OrganicTextContentSpan, .TextContainer, .organic__content-wrapper')),
        rank: hits.length + 1,
      });
    }
    return hits;
  },
};
