import type { BrowserEngine, FetchLike, SearchHit } from '../types';
import { normalizeUrl } from '../url';
import { absoluteHttpUrl, cleanText } from './shared';

const GOOGLE_HOST = /(^|\.)google\.(?:com|[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2,3})$/i;
const MAX_REDIRECT_CONCURRENCY = 5;
const REDIRECT_TIMEOUT_MS = 4000;

function isGoogleHost(hostname: string): boolean {
  return GOOGLE_HOST.test(hostname);
}

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
    if (isGoogleHost(parsed.hostname)) return null;
  } catch {
    return null;
  }
  return url;
}

async function resolveRedirect(
  hit: SearchHit,
  fetch: FetchLike,
  signal: AbortSignal,
): Promise<SearchHit> {
  let wrapper: URL;
  try {
    wrapper = new URL(hit.url);
  } catch {
    return hit;
  }
  if (wrapper.protocol !== 'https:' || !isGoogleHost(wrapper.hostname) || wrapper.pathname !== '/goto') return hit;

  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), REDIRECT_TIMEOUT_MS);

  try {
    const response = await fetch(wrapper.href, { signal: controller.signal });
    if (!response.ok) return hit;
    const finalUrl = absoluteHttpUrl(response.url, wrapper.href);
    if (finalUrl && !isGoogleHost(new URL(finalUrl).hostname)) return { ...hit, url: finalUrl };

    const body = await response.text();
    const anchor = body.match(/<a\b[^>]*\bhref\s*=\s*(["'])(https?:\/\/[^"']+)\1/i);
    const target = absoluteHttpUrl(anchor?.[2]?.replace(/&amp;/gi, '&'), wrapper.href);
    return target && !isGoogleHost(new URL(target).hostname) ? { ...hit, url: target } : hit;
  } catch {
    return hit;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
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
  async resolve(hits, { fetch, signal }) {
    const resolved = hits.slice();
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(MAX_REDIRECT_CONCURRENCY, hits.length) }, async () => {
      while (!signal.aborted) {
        const index = nextIndex++;
        if (index >= hits.length) return;
        resolved[index] = await resolveRedirect(hits[index], fetch, signal);
      }
    });
    await Promise.all(workers);

    const seen = new Set<string>();
    return resolved
      .filter((hit) => {
        const key = normalizeUrl(hit.url);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((hit, index) => ({ ...hit, rank: index + 1 }));
  },
};
