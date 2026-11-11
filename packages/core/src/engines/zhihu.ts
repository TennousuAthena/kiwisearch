import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText, parseCount } from './shared';

const CONTENT_PATH = /^\/(?:question\/\d+(?:\/answer\/\d+)?|p\/\d+)$/;
const SNIPPET_MAX = 300;

/** An answer, question or article link without tracking parameters; topics, people and ads are not results. */
function contentUrl(href: string | null | undefined, pageUrl: string): string | null {
  const absolute = absoluteHttpUrl(href, pageUrl);
  if (!absolute) return null;
  const url = new URL(absolute);
  if (!/(^|\.)zhihu\.com$/.test(url.hostname)) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return CONTENT_PATH.test(path) ? `${url.origin}${path}` : null;
}

/** Needs the user's own logged-in browser: the search page is only worth reading when signed in. */
export const zhihu: BrowserEngine = {
  id: 'zhihu',
  label: '知乎',
  modes: ['zhihu'],
  buildUrl: (query) => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`,
  matches: ['*://www.zhihu.com/search*', '*://www.zhihu.com/signin*', '*://www.zhihu.com/account/*'],
  readySelector: '.ContentItem',
  // Both are guesses: the sign-in page was seen once, but no logged-out search page was captured.
  loginSelector: '.SignFlow',
  isLoginUrl: (url) => /^\/signin(?:\/|$)/.test(new URL(url).pathname),
  // Zhihu's own verification page; the path is from memory and was never captured.
  blockedSelector: ':not(*)',
  isBlockedUrl: (url) => /^\/account\/unhuman(?:\/|$)/.test(new URL(url).pathname),
  // What a fresh headless browser got on the search URL (a JSON body, error code 40362): "your request looks abnormal, access limited for now".
  refusedPattern: /您当前请求存在异常|暂时限制本次访问/,
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const item of doc.querySelectorAll('.ContentItem')) {
      const link = item.querySelector('.ContentItem-title a[href]');
      const url = contentUrl(link?.getAttribute('href'), pageUrl);
      const title = cleanText(link);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      const rich = item.querySelector('.RichText');
      // The excerpt starts with the author's name in bold, then a colon.
      const author = cleanText(rich?.querySelector('b[data-first-child]')) || undefined;
      let body = cleanText(rich);
      if (author && body.startsWith(author)) body = body.slice(author.length).replace(/^\s*[:：]\s*/, '');
      const vote = [...item.querySelectorAll('button.VoteButton')].find((button) => !button.classList.contains('VoteButton--down'));
      const comments = [...item.querySelectorAll('button')].map((button) => cleanText(button)).find((text) => /条评论/.test(text));
      const cover = absoluteHttpUrl(item.querySelector('.RichContent-cover img')?.getAttribute('src'), pageUrl) ?? undefined;
      hits.push({
        url,
        host: 'zhihu.com',
        title,
        snippet: body.length > SNIPPET_MAX ? `${body.slice(0, SNIPPET_MAX - 1)}…` : body,
        content: body || undefined,
        rank: hits.length + 1,
        meta: {
          author,
          votes: parseCount(vote?.getAttribute('aria-label')),
          comments: parseCount(comments),
          age: cleanText(item.querySelector('.SearchItem-time')) || undefined,
          thumbnail: cover,
          siteName: '知乎',
        },
      });
    }
    return hits;
  },
};
