import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText, parseCount } from './shared';

// Douyin's video-tab list and card CSS modules, read from its public search bundles
// on 2026-11-13 (modules 714567, 678422, 964299 and 167458). A signed-in result
// capture is still needed; the available browser sessions stopped at the login wall.
const CARDS = 'ul.PAjzsG5a > li .search-result-card:not(.search-prediction-card)';
const TITLE = '.VDYK8Xd7';

function videoUrl(raw: string | null, pageUrl: string): string | null {
  const absolute = absoluteHttpUrl(raw, pageUrl);
  if (!absolute) return null;
  const url = new URL(absolute);
  if (url.hostname !== 'www.douyin.com' && url.hostname !== 'douyin.com') return null;
  const id = url.pathname.match(/^\/video\/(\d+)\/?$/)?.[1];
  return id ? `https://www.douyin.com/video/${id}` : null;
}

/** Reads only the dedicated video tab, using the user's browser login. */
export const douyin: BrowserEngine = {
  id: 'douyin',
  label: '抖音',
  modes: ['video'],
  buildUrl: (query) => `https://www.douyin.com/search/${encodeURIComponent(query)}?type=video`,
  matches: ['*://www.douyin.com/search/*'],
  readySelector: `${CARDS} a._4furHfW[href] ${TITLE}`,
  // Captured from a real signed-out search, not the optional header login button.
  loginSelector: '#douyin_login_comp_flat_panel_title',
  // The real worker tab can receive this captcha iframe at the unchanged search
  // URL. The parent page has no visible text, so a text/URL check would miss it.
  blockedSelector: 'iframe[src^="https://rmc.bytedance.com/verifycenter/captcha/"]',
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const card of doc.querySelectorAll(CARDS)) {
      const link = card.querySelector('a._4furHfW[href]');
      const url = videoUrl(link?.getAttribute('href') ?? null, pageUrl);
      const title = cleanText(link?.querySelector(TITLE));
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      const image = link?.querySelector('.videoImage img');
      const thumbnail = absoluteHttpUrl(image?.getAttribute('src'), pageUrl) ?? undefined;
      const likes = parseCount(cleanText(link?.querySelector('.cIiU4Muu')));
      hits.push({
        url,
        host: 'douyin.com',
        title,
        snippet: '',
        rank: hits.length + 1,
        // The cover counter is likes, not views; the author is a span whose click
        // handler opens the profile, so the DOM does not provide a channel URL.
        meta: { votes: likes },
        video: {
          thumbnail,
          duration: cleanText(link?.querySelector('.ckopQfVu')) || undefined,
          channel: cleanText(link?.querySelector('.MZNczJmS')) || undefined,
          published: cleanText(link?.querySelector('.faDtinfi')) || undefined,
        },
      });
    }
    return hits;
  },
};
