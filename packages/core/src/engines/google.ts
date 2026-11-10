import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

function resultUrl(href: string | null, pageUrl: string): string | null {
  const url = absoluteHttpUrl(href, pageUrl);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/url') {
      const target = parsed.searchParams.get('q') ?? parsed.searchParams.get('url');
      return absoluteHttpUrl(target, pageUrl);
    }
    if (parsed.pathname === '/goto' && parsed.searchParams.has('url')) return parsed.href;
    if (/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname)) return null;
  } catch {
    return null;
  }
  return url;
}

export const google: BrowserEngine = {
  id: 'google',
  label: 'Google',
  kind: 'web',
  buildUrl: (query, count) => `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${Math.min(count, 20)}`,
  matches: ['*://*.google.com/search*', '*://*.google.com/sorry/*', '*://*.google.com.hk/search*'],
  readySelector: '#search a h3, #rso a h3',
  blockedSelector: '#captcha-form, form[action*="sorry"], [id*="captcha"], iframe[src*="recaptcha"]',
  isBlockedUrl: (url) => /\/sorry(?:\/|$)|recaptcha/i.test(new URL(url).pathname + new URL(url).search),
  extract(doc, pageUrl) {
    const scope = doc.querySelector('#search') ?? doc.querySelector('#rso') ?? doc;
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const heading of scope.querySelectorAll('a h3')) {
      const anchor = heading.closest('a');
      const url = resultUrl(anchor?.getAttribute('href') ?? null, pageUrl);
      const title = cleanText(heading);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      const block = heading.closest('.MjjYud, .g, .tF2Cxc, [data-hveid]') ?? anchor?.parentElement;
      const snippet = cleanText(block?.querySelector('.VwiC3b, [data-sncf], [style*="-webkit-line-clamp"]'));
      hits.push({ url, title, snippet, rank: hits.length + 1 });
    }
    return hits;
  },
};
