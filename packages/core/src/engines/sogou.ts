import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

const SOGOU_HOST = /(^|\.)sogou\.com$/i;
const SNIPPET_MAX = 300;

/** Sogou's own redirect links, `/link?url=…`: clicking one opens the real page. */
function isSogouRedirect(url: URL): boolean {
  return SOGOU_HOST.test(url.hostname) && url.pathname === '/link';
}

function limit(text: string): string {
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1)}…` : text;
}

// The captcha page's address and form were not captured, so both are guesses (the page path is what Sogou's anti-spider uses).
const BLOCKED_SELECTOR = '#seccodeForm, #seccodeImage';
const isAntispider = (url: string) => /^\/antispider/.test(new URL(url).pathname);

/**
 * Sogou web search. It has its own index and shows Sogou's vertical cards (encyclopedia, TV listings) between the results;
 * those that carry a title and a real link are kept, jump links into Sogou's own pages are not.
 */
export const sogou: BrowserEngine = {
  id: 'sogou',
  label: '搜狗',
  modes: ['web'],
  buildUrl: (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`,
  matches: ['*://www.sogou.com/web*', '*://www.sogou.com/antispider*'],
  readySelector: '.vrwrap h3 a',
  blockedSelector: BLOCKED_SELECTOR,
  isBlockedUrl: isAntispider,
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const card of doc.querySelectorAll('.vrwrap')) {
      const link = card.querySelector('h3 a');
      const url = absoluteHttpUrl(link?.getAttribute('href'), pageUrl);
      const title = cleanText(link);
      if (!url || !title || seen.has(url)) continue;
      const parsed = new URL(url);
      // A jump into Sogou's own pages ("related searches", "ask Sogou") is not a result.
      if (parsed.hostname === 'www.sogou.com' && !isSogouRedirect(parsed)) continue;
      seen.add(url);
      // Some cards carry the real site in `data-url`. The link itself stays Sogou's redirect, which is known to work when opened.
      const real = absoluteHttpUrl(card.querySelector('[data-url]')?.getAttribute('data-url'), pageUrl);
      const realHost = real && !SOGOU_HOST.test(new URL(real).hostname) ? new URL(real).hostname.replace(/^www\./, '') : undefined;
      hits.push({
        url,
        host: isSogouRedirect(parsed) ? realHost : parsed.hostname.replace(/^www\./, ''),
        title,
        snippet: limit(cleanText(card.querySelector('.space-txt, .star-wiki, .fz-mid'))),
        rank: hits.length + 1,
      });
    }
    return hits;
  },
};

/**
 * Sogou's WeChat search: articles from official accounts (公众号), which ordinary engines mostly cannot see.
 * Result links are Sogou redirects (`/link?url=…`); opening one without a Referer lands on the article at mp.weixin.qq.com.
 */
export const weixin: BrowserEngine = {
  id: 'weixin',
  label: '搜狗微信',
  modes: ['wechat'],
  buildUrl: (query) => `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(query)}&ie=utf8&s_from=input&_sug_=n&_sug_type_=`,
  matches: ['*://weixin.sogou.com/weixin*', '*://weixin.sogou.com/antispider*'],
  readySelector: 'ul.news-list > li .txt-box h3 a',
  blockedSelector: BLOCKED_SELECTOR,
  isBlockedUrl: isAntispider,
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const item of doc.querySelectorAll('ul.news-list > li')) {
      const link = item.querySelector('.txt-box h3 a');
      const url = absoluteHttpUrl(link?.getAttribute('href'), pageUrl);
      const title = cleanText(link);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      // The date is written by a script, `timeConvert('<unix seconds>')`. The number is read from its text; the script is never run.
      const stamp = item.querySelector('.s-p script')?.textContent?.match(/timeConvert\('(\d{9,11})'\)/)?.[1];
      hits.push({
        url,
        host: 'mp.weixin.qq.com',
        title,
        snippet: limit(cleanText(item.querySelector('.txt-info'))),
        rank: hits.length + 1,
        publishedAt: stamp ? new Date(Number(stamp) * 1000).toISOString() : undefined,
        meta: {
          author: cleanText(item.querySelector('.s-p .all-time-y2, .s-p a.account')) || undefined,
          thumbnail: absoluteHttpUrl(item.querySelector('.img-box img')?.getAttribute('src'), pageUrl) ?? undefined,
          siteName: '微信公众号',
        },
      });
    }
    return hits;
  },
};
