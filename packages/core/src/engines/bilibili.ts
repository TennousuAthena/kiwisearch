import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

const VIDEO_PATH = /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i;

/** Card links are protocol-relative (`//www.bilibili.com/video/BV…/`); keep only the video itself, without tracking or part numbers. */
function videoUrl(href: string | null | undefined, pageUrl: string): string | null {
  const absolute = absoluteHttpUrl(href, pageUrl);
  if (!absolute) return null;
  const url = new URL(absolute);
  const id = url.pathname.match(VIDEO_PATH)?.[1];
  return id && /(^|\.)bilibili\.com$/.test(url.hostname) ? `https://www.bilibili.com/video/${id}/` : null;
}

export const bilibili: BrowserEngine = {
  id: 'bilibili',
  label: '哔哩哔哩',
  modes: ['video'],
  buildUrl: (query) => `https://search.bilibili.com/video?keyword=${encodeURIComponent(query)}`,
  matches: ['*://search.bilibili.com/video*', '*://search.bilibili.com/all*'],
  // Cards are rendered by the page's scripts; the title is the last part to appear in one.
  readySelector: '.bili-video-card .bili-video-card__info--tit',
  // The slider captcha (Geetest) that Bilibili is known to raise when it distrusts a client. Not seen in a capture yet.
  blockedSelector: '.geetest_panel, .geetest_widget, .geetest_holder, #gc-box',
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const card of doc.querySelectorAll('.bili-video-card')) {
      const heading = card.querySelector('.bili-video-card__info--tit');
      const url = videoUrl((heading?.closest('a') ?? card.querySelector('a[href*="/video/"]'))?.getAttribute('href'), pageUrl);
      const title = cleanText(heading) || (heading?.getAttribute('title') ?? '').trim();
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      const cover = card.querySelector('.bili-video-card__cover');
      const thumbnail = absoluteHttpUrl(
        cover?.querySelector('img')?.getAttribute('src') ?? cover?.querySelector('source')?.getAttribute('srcset')?.split(/\s/)[0],
        pageUrl,
      );
      // The overlay shows views first, then danmaku (comment) count; both are bare numbers next to an icon.
      const views = cleanText(card.querySelector('.bili-video-card__stats--item'));
      hits.push({
        url,
        host: 'bilibili.com',
        title,
        snippet: '',
        rank: hits.length + 1,
        video: {
          thumbnail: thumbnail ?? undefined,
          duration: cleanText(card.querySelector('.bili-video-card__stats__duration')) || undefined,
          channel: cleanText(card.querySelector('.bili-video-card__info--author')) || undefined,
          channelUrl: absoluteHttpUrl(card.querySelector('.bili-video-card__info--owner')?.getAttribute('href'), pageUrl) ?? undefined,
          views: views ? `${views}播放` : undefined,
          published: cleanText(card.querySelector('.bili-video-card__info--date')).replace(/^[\s·]+/, '') || undefined,
        },
      });
    }
    return hits;
  },
};
