import type { BrowserEngine } from '../types';
import { absoluteHttpUrl } from './shared';

interface YtText {
  simpleText?: string;
  runs?: { text?: string; navigationEndpoint?: { browseEndpoint?: { canonicalBaseUrl?: string } } }[];
}

interface YtVideoRenderer {
  videoId?: string;
  title?: YtText;
  ownerText?: YtText;
  longBylineText?: YtText;
  publishedTimeText?: YtText;
  lengthText?: YtText;
  viewCountText?: YtText;
  detailedMetadataSnippets?: { snippetText?: YtText }[];
  descriptionSnippet?: YtText;
  thumbnail?: { thumbnails?: { url?: string }[] };
}

const DATA_MARKER = 'ytInitialData = ';

function text(value: YtText | undefined): string {
  const joined = value?.simpleText ?? value?.runs?.map((run) => run.text ?? '').join('') ?? '';
  return joined.replace(/\s+/g, ' ').trim();
}

/** The search page ships its results as JSON in an inline script, so no rendering is needed to read them. */
function readInitialData(doc: ParentNode): unknown {
  for (const script of doc.querySelectorAll('script')) {
    const source = script.textContent ?? '';
    const at = source.indexOf(DATA_MARKER);
    if (at < 0) continue;
    const start = source.indexOf('{', at);
    const end = source.lastIndexOf('}');
    if (start < 0 || end < start) continue;
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch {
      /* a script that mentions the marker without being the data */
    }
  }
  return null;
}

/** Every `videoRenderer` in document order. Shelves (Shorts, "people also watched") use other keys and are left out. */
function collectVideoRenderers(node: unknown, out: YtVideoRenderer[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectVideoRenderers(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'videoRenderer' && value && typeof value === 'object') out.push(value as YtVideoRenderer);
    else collectVideoRenderers(value, out);
  }
}

export const youtube: BrowserEngine = {
  id: 'youtube',
  label: 'YouTube',
  modes: ['video'],
  buildUrl: (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
  matches: ['*://www.youtube.com/results*', '*://consent.youtube.com/*', '*://www.youtube.com/sorry/*'],
  // The results are read from the page's inline data, which is there as soon as the document is.
  readySelector: 'body',
  // EU visitors are sent to a cookie-consent page first; it needs one click from the user.
  blockedSelector: 'form[action*="consent.youtube.com"], ytd-consent-bump-v2-renderer, #captcha-form',
  isBlockedUrl: (url) => {
    const { hostname, pathname } = new URL(url);
    return hostname === 'consent.youtube.com' || /^\/sorry(?:\/|$)/.test(pathname);
  },
  extract(doc, pageUrl) {
    const renderers: YtVideoRenderer[] = [];
    collectVideoRenderers(readInitialData(doc), renderers);
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const item of renderers) {
      const id = item.videoId;
      const title = text(item.title);
      if (!id || !/^[\w-]{11}$/.test(id) || !title || seen.has(id)) continue;
      seen.add(id);
      const channelPath = (item.ownerText ?? item.longBylineText)?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl;
      const snippet = text(item.detailedMetadataSnippets?.[0]?.snippetText) || text(item.descriptionSnippet);
      hits.push({
        url: `https://www.youtube.com/watch?v=${id}`,
        host: 'youtube.com',
        title,
        snippet,
        rank: hits.length + 1,
        video: {
          thumbnail: absoluteHttpUrl(item.thumbnail?.thumbnails?.[0]?.url, pageUrl) ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
          duration: text(item.lengthText) || undefined,
          channel: text(item.ownerText ?? item.longBylineText) || undefined,
          channelUrl: absoluteHttpUrl(channelPath, pageUrl) ?? undefined,
          views: text(item.viewCountText) || undefined,
          published: text(item.publishedTimeText) || undefined,
        },
      });
    }
    return hits;
  },
};
