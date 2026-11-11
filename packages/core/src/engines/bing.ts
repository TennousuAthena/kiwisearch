import type { BrowserEngine, SearchMode } from '../types';
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

interface BingImageMeta {
  murl?: string;
  purl?: string;
  turl?: string;
  t?: string;
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Each tile is `a.iusc` whose `m` attribute is JSON: `murl` (image file), `purl` (page showing it),
 * `turl` (thumbnail), `t` (title, with private-use characters marking the matched words).
 */
function extractImages(doc: ParentNode, pageUrl: string): ReturnType<BrowserEngine['extract']> {
  const hits: ReturnType<BrowserEngine['extract']> = [];
  const seen = new Set<string>();
  for (const tile of doc.querySelectorAll('a.iusc')) {
    const meta = parseJson<BingImageMeta>(tile.getAttribute('m'));
    const src = absoluteHttpUrl(meta?.murl, pageUrl);
    const page = absoluteHttpUrl(meta?.purl, pageUrl);
    if (!src || !page || seen.has(src)) continue;
    seen.add(src);
    const img = tile.querySelector('img');
    const thumbnail = absoluteHttpUrl(meta?.turl, pageUrl) ?? absoluteHttpUrl(img?.getAttribute('src') ?? img?.getAttribute('data-src'), pageUrl) ?? src;
    const title = (meta?.t ?? img?.getAttribute('alt') ?? '').replace(/[\ue000-\uf8ff]/g, '').replace(/^Image result for\s+/i, '').replace(/\s+/g, ' ').trim();
    // Tile dimensions are the thumbnail's; only the aspect ratio matters for layout.
    const width = Number(img?.getAttribute('width')) || undefined;
    const height = Number(img?.getAttribute('height')) || undefined;
    hits.push({
      url: page,
      title: title || new URL(page).hostname,
      snippet: '',
      rank: hits.length + 1,
      image: { src, thumbnail, ...(width && height ? { width, height } : {}) },
    });
  }
  return hits;
}

export const bing: BrowserEngine = {
  id: 'bing',
  label: 'Bing',
  modes: ['web', 'images'],
  buildUrl: (query, count, mode: SearchMode) =>
    mode === 'images'
      ? `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`
      : `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 50)}`,
  matches: ['*://*.bing.com/search*', '*://*.bing.com/images/search*', '*://*.bing.com/ck/*', '*://*.bing.com/captcha*'],
  readySelector: '#b_results li.b_algo h2 a, a.iusc',
  blockedSelector: '#b_captcha, #captcha, form[action*="captcha"], .captchaContainer',
  isBlockedUrl: (url) => /\/captcha(?:\/|$)/i.test(new URL(url).pathname),
  extract(doc, pageUrl, mode) {
    if (mode === 'images') return extractImages(doc, pageUrl);
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
