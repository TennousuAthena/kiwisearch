import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

const STATUS_PATH = /^\/([^/]+)\/status\/(\d+)/;
const TEXT_MAX = 300;

/** "1218 replies, 2686 reposts, 16661 likes, 18542 bookmarks, 5026349 views": the number in front of one of the words. */
function stat(label: string, word: string): number | undefined {
  const match = label.match(new RegExp(`([\\d,]+)\\s+${word}`, 'i'));
  return match ? Number(match[1].replace(/,/g, '')) : undefined;
}

/** An X Article (long-form post) has no tweet text, only a cover with a title and a preview next to it. */
function articleText(tweet: Element): string {
  const cover = tweet.querySelector('[data-testid="article-cover-image"]');
  const parts = [...(cover?.parentElement?.querySelectorAll('[dir="auto"]') ?? [])].filter((node) => !node.querySelector('[dir="auto"]')).map(cleanText);
  return parts.filter(Boolean).join(' — ');
}

/**
 * X (Twitter) search. Needs the user's signed-in browser; signed out, X redirects a search to its onboarding page.
 * X renders a virtualized list, so only the tweets near the top of the page are in the DOM when the page is read.
 */
export const x: BrowserEngine = {
  id: 'x',
  label: 'X',
  modes: ['x'],
  buildUrl: (query) => `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query`,
  matches: ['*://x.com/search*', '*://x.com/i/jf/onboarding*', '*://x.com/i/flow/login*', '*://x.com/login*', '*://x.com/account/access*'],
  readySelector: 'article[data-testid="tweet"]',
  loginSelector: '[data-testid="loginButton"], [data-testid="signupButton"]',
  // Seen when signed out: the search redirects to /i/jf/onboarding/web.
  isLoginUrl: (url) => /^\/(?:i\/jf\/onboarding|i\/flow\/login|login)(?:\/|$)/.test(new URL(url).pathname),
  // The challenge page X shows when it wants proof of a human; the path is from memory and was never captured.
  blockedSelector: ':not(*)',
  isBlockedUrl: (url) => /^\/account\/access(?:\/|$)/.test(new URL(url).pathname),
  // X polices automated use of an account closely, so it gets a longer gap than the other engines.
  minIntervalMs: 10_000,
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const tweet of doc.querySelectorAll('article[data-testid="tweet"]')) {
      // A promoted tweet carries a bare "Ad" label.
      if ([...tweet.querySelectorAll('span')].some((span) => cleanText(span) === 'Ad')) continue;
      // The tweet's own permalink is the link around its time; a quoted tweet inside it has no such link.
      const timeEl = tweet.querySelector('a[href*="/status/"] time[datetime]');
      const status = absoluteHttpUrl(timeEl?.closest('a')?.getAttribute('href'), pageUrl);
      const path = status ? new URL(status).pathname.match(STATUS_PATH) : null;
      if (!path) continue;
      const url = `https://x.com/${path[1]}/status/${path[2]}`;
      if (seen.has(url)) continue;
      seen.add(url);
      const name = cleanText(tweet.querySelector('[data-testid="User-Name"] a span'));
      // A quoted tweet repeats the author line and text inside a link container; only the tweet's own text counts.
      const own = [...tweet.querySelectorAll('[data-testid="tweetText"]')].find((node) => !node.closest('[role="link"]'));
      const text = own ? cleanText(own) : articleText(tweet);
      const label = tweet.querySelector('[role="group"][aria-label]')?.getAttribute('aria-label') ?? '';
      const media =
        tweet.querySelector('[data-testid="tweetPhoto"] img[src*="pbs.twimg.com/media"]')?.getAttribute('src') ??
        tweet.querySelector('video[poster]')?.getAttribute('poster');
      const posted = Date.parse(timeEl?.getAttribute('datetime') ?? '');
      hits.push({
        url,
        host: 'x.com',
        title: name ? `${name} (@${path[1]})` : `@${path[1]}`,
        snippet: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text,
        content: text || undefined,
        rank: hits.length + 1,
        publishedAt: Number.isNaN(posted) ? undefined : new Date(posted).toISOString(),
        meta: {
          author: `@${path[1]}`,
          comments: stat(label, 'repl(?:y|ies)'),
          reposts: stat(label, 'reposts?'),
          votes: stat(label, 'likes?'),
          views: stat(label, 'views?'),
          thumbnail: absoluteHttpUrl(media, pageUrl) ?? undefined,
          siteName: 'X',
        },
      });
    }
    return hits;
  },
};
