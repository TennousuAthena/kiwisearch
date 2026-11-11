import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

export function decodeBingUrl(href: string, pageUrl: string): string | null {
  const absolute = absoluteHttpUrl(href, pageUrl);
  if (!absolute) return null;
  try {
    const url = new URL(absolute);
    if (url.hostname.endsWith('bing.com') && url.pathname.startsWith('/ck/')) {
      const encoded = url.searchParams.get('u');
      if (encoded?.startsWith('a1')) {
        const base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return absoluteHttpUrl(new TextDecoder().decode(bytes), pageUrl);
      }
    }
    return url.href;
  } catch {
    return null;
  }
}

export const bing: BrowserEngine = {
  id: 'bing',
  label: 'Bing',
  kind: 'web',
  buildUrl: (query, count) => `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 50)}`,
  matches: ['*://*.bing.com/search*', '*://*.bing.com/ck/*', '*://*.bing.com/captcha*'],
  readySelector: '#b_results li.b_algo h2 a',
  blockedSelector: '#b_captcha, #captcha, form[action*="captcha"], .captchaContainer',
  isBlockedUrl: (url) => /\/captcha(?:\/|$)/i.test(new URL(url).pathname),
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    for (const item of doc.querySelectorAll('li.b_algo')) {
      const anchor = item.querySelector('h2 a');
      const url = anchor ? decodeBingUrl(anchor.getAttribute('href') ?? '', pageUrl) : null;
      const title = cleanText(anchor);
      if (!url || !title) continue;
      const snippet = cleanText(item.querySelector('.b_caption p, .b_lineclamp2, .b_lineclamp3, p')).replace(/^\S+\s·\s/, '');
      hits.push({ url, title, snippet, rank: hits.length + 1 });
    }
    return hits;
  },
};
