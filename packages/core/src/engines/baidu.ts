import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

export const baidu: BrowserEngine = {
  id: 'baidu',
  label: '百度',
  modes: ['web'],
  buildUrl: (query, count) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${Math.min(count, 50)}`,
  matches: ['*://*.baidu.com/s*', '*://wappass.baidu.com/*', '*://passport.baidu.com/*'],
  readySelector: '#content_left .result, #content_left .c-container',
  blockedSelector: 'form[action*="wappass"], #passport-login-pop, .passMod_dialog',
  isBlockedUrl: (url) => /(^|\.)wappass\.baidu\.com$|(^|\.)passport\.baidu\.com$/i.test(new URL(url).hostname),
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    for (const item of doc.querySelectorAll('#content_left .result, #content_left .c-container')) {
      const heading = item.querySelector('h3');
      const anchor = heading?.querySelector('a') ?? item.querySelector('h3 a, a[href]');
      const target = item.getAttribute('mu');
      const url = absoluteHttpUrl(target, pageUrl) ?? absoluteHttpUrl(anchor?.getAttribute('href'), pageUrl);
      const title = cleanText(heading ?? anchor);
      if (!url || !title) continue;
      const snippet = cleanText(item.querySelector('.c-abstract, .content-right_8Zs40, [class*="abstract"]'));
      hits.push({ url, title, snippet, rank: hits.length + 1 });
    }
    return hits;
  },
};
