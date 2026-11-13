import type { BrowserEngine, FetchLike, SearchHit } from '../types';
import { normalizeUrl } from '../url';
import { absoluteHttpUrl, cleanText } from './shared';
import { normalizeNewsOptions, parseNewsTime } from '../news';
import { newsThumbnail } from './news';

const GOOGLE_HOST = /(^|\.)google\.(?:com|[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2,3})$/i;
const MAX_REDIRECT_CONCURRENCY = 5;
const REDIRECT_TIMEOUT_MS = 4000;

function isGoogleHost(hostname: string): boolean {
  return GOOGLE_HOST.test(hostname);
}

export function isGoogleGotoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && isGoogleHost(url.hostname) && url.pathname === '/goto' && url.searchParams.has('url');
  } catch {
    return false;
  }
}

function extractHost(cite: Element | null | undefined): string | undefined {
  const token = cleanText(cite).replace(/[\u200e\u200f\u202a-\u202e]/g, '').split(/\s*›\s*|\s+/)[0];
  if (!token) return undefined;
  try {
    const url = new URL(token);
    if (!/^https?:$/.test(url.protocol)) return undefined;
    return url.hostname.replace(/^www\./i, '');
  } catch {
    return undefined;
  }
}

function hasMetaUrl(body: string): boolean {
  return [...body.matchAll(/<meta\b[^>]*>/gi)].some(([tag]) => /\burl\s*=/i.test(tag));
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
  if (!isGoogleGotoUrl(hit.url)) return hit;
  const wrapper = new URL(hit.url);

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
    if (hasMetaUrl(body)) return hit;
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
  modes: ['web', 'news'],
  buildUrl(query, count, mode, _language, news) {
    const base = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${Math.min(count, 20)}`;
    if (mode !== 'news') return base;
    const options = normalizeNewsOptions(news);
    const range = { any: '', day: 'd', week: 'w', month: 'm' }[options.range];
    const filters = [range ? `qdr:${range}` : '', options.sort === 'date' ? 'sbd:1' : ''].filter(Boolean);
    return `${base}&tbm=nws${filters.length ? `&tbs=${encodeURIComponent(filters.join(','))}` : ''}`;
  },
  matches: ['*://*.google.com/search*', '*://*.google.com/sorry/*', '*://*.google.com.hk/search*'],
  readySelector: '#search a h3, #rso a h3, #search a [role="heading"][aria-level="3"]',
  blockedSelector: '#captcha-form, form[action*="sorry"], [id*="captcha"], iframe[src*="recaptcha"]',
  isBlockedUrl: (url) => /\/sorry(?:\/|$)|recaptcha/i.test(new URL(url).pathname + new URL(url).search),
  extract(doc, pageUrl, mode, now = new Date()) {
    if (mode === 'news') return extractNews(doc, pageUrl, now);
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
      const host = isGoogleGotoUrl(url) ? extractHost(block?.querySelector('cite')) : undefined;
      hits.push({ url, title, snippet, rank: hits.length + 1, ...(host ? { host } : {}) });
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
        const key = normalizeUrl(hit.url, !hit.news);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((hit, index) => ({ ...hit, rank: index + 1 }));
  },
};

/** Google News search uses role headings, including the individual stories inside topic clusters. */
function extractNews(doc: ParentNode, pageUrl: string, now: Date): ReturnType<BrowserEngine['extract']> {
  const hits: ReturnType<BrowserEngine['extract']> = [];
  const seen = new Set<string>();
  const scope = doc.querySelector('#search') ?? doc.querySelector('#rso') ?? doc;
  for (const heading of scope.querySelectorAll('a [role="heading"][aria-level="3"]')) {
    const card = heading.closest('a');
    const url = resultUrl(card?.getAttribute('href') ?? null, pageUrl);
    const title = cleanText(heading);
    if (!card || !url || !title || seen.has(url)) continue;
    seen.add(url);
    const timeElement = card.querySelector('[data-ts]') ?? card.querySelector('time') ?? card.querySelector('.LfVVr');
    const timeText = cleanText(timeElement);
    const stamp = Number(timeElement?.getAttribute('data-ts'));
    const date = stamp > 0 && Number.isFinite(stamp) && stamp * 1000 <= now.getTime() ? new Date(stamp * 1000).toISOString() : undefined;
    const timeKind = parseNewsTime(timeText, now).news.timeKind;
    const time = parseNewsTime(date ?? timeElement?.getAttribute('datetime') ?? timeText, now, timeKind);
    const image = card.querySelector('.gpjNTe img, .uhHOwf img');
    hits.push({
      url,
      title,
      snippet: cleanText(card.querySelector('.UqSP2b, .GI74Re')).slice(0, 300),
      rank: hits.length + 1,
      ...time,
      news: {
        ...time.news,
        ...(timeText ? { timeText } : {}),
        publisher: cleanText(card.querySelector('.MgUUmf span')) || undefined,
        thumbnail: newsThumbnail(image?.getAttribute('src') ?? image?.getAttribute('data-src'), pageUrl),
      },
    });
  }
  return hits;
}
