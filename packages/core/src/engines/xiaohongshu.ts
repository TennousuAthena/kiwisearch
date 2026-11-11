import type { BrowserEngine, SourceId } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

const NOTE_PATH = /^\/search_result\/[0-9a-f]{24}$/i;

/**
 * The page's own note link. It carries `xsec_token` / `xsec_source`, which the site needs to open the note,
 * so those are kept and everything else is dropped.
 */
function noteUrl(href: string | null | undefined, pageUrl: string): string | null {
  const absolute = absoluteHttpUrl(href, pageUrl);
  if (!absolute) return null;
  const url = new URL(absolute);
  if (!NOTE_PATH.test(url.pathname)) return null;
  const clean = new URL(url.origin + url.pathname);
  for (const key of ['xsec_token', 'xsec_source']) if (url.searchParams.has(key)) clean.searchParams.set(key, url.searchParams.get(key) ?? '');
  return clean.href;
}

/** Xiaohongshu has a mainland site and an international one (RedNote). Same notes and ids, separate domains and logins. */
function noteEngine(id: Extract<SourceId, 'xiaohongshu' | 'rednote'>, label: string, origin: string): BrowserEngine {
  const hostname = new URL(origin).hostname;
  const host = hostname.replace(/^www\./, '');
  return {
    id,
    label,
    modes: ['xiaohongshu'],
    buildUrl: (query) => `${origin}/search_result?keyword=${encodeURIComponent(query)}&source=web_search_result_notes`,
    matches: [`*://${hostname}/search_result*`],
    readySelector: 'section.note-item',
    // A guess: the logged-out explore page shows a modal; no logged-out search page was captured.
    blockedSelector: '.login-container',
    extract(doc, pageUrl) {
      const hits: ReturnType<BrowserEngine['extract']> = [];
      const seen = new Set<string>();
      for (const card of doc.querySelectorAll('section.note-item')) {
        const titleLink = card.querySelector('a.title');
        const url = noteUrl((titleLink ?? card.querySelector('a.cover'))?.getAttribute('href'), pageUrl);
        // The same note can be linked more than once with different tokens; its id is what makes it one note.
        const id = url ? new URL(url).pathname : '';
        if (!url || seen.has(id)) continue;
        seen.add(id);
        const author = card.querySelector('a.author');
        hits.push({
          url,
          host,
          title: cleanText(titleLink) || '无标题笔记',
          snippet: '',
          rank: hits.length + 1,
          note: {
            cover: absoluteHttpUrl(card.querySelector('a.cover img')?.getAttribute('src'), pageUrl) ?? undefined,
            width: Number(card.getAttribute('data-width')) || undefined,
            height: Number(card.getAttribute('data-height')) || undefined,
            author: cleanText(author?.querySelector('.name')) || undefined,
            avatar: absoluteHttpUrl(author?.querySelector('img')?.getAttribute('src'), pageUrl) ?? undefined,
            time: cleanText(author?.querySelector('.time')) || undefined,
            likes: cleanText(card.querySelector('.like-wrapper .count')) || undefined,
          },
        });
      }
      return hits;
    },
  };
}

export const xiaohongshu = noteEngine('xiaohongshu', '小红书', 'https://www.xiaohongshu.com');
export const rednote = noteEngine('rednote', 'RedNote', 'https://www.rednote.com');
