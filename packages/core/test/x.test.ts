import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resultCount, usableSources } from '../src/config';
import { x } from '../src/engines/x';
import { ROUTES } from '../src/intent';
import { runSearch } from '../src/pipeline';
import { SEARCH_MODES, modeHasText } from '../src/types';
import type { Env, PipelineEvent } from '../src/types';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const dom = (html: string) => {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as ParentNode;
};
const PAGE = 'https://x.com/search?q=openai&src=typed_query';

describe('X engine (real captured page, see the fixture header)', () => {
  const hits = x.extract(dom(fixture('x.html')), PAGE, 'x');

  it('reads every tweet in order, once, with a permalink on x.com', () => {
    expect(hits).toHaveLength(6);
    expect(hits.map((hit) => hit.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(6);
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https:\/\/x\.com\/\w+\/status\/\d+$/);
      expect(hit.host).toBe('x.com');
      expect(hit.title).toMatch(/\(@\w+\)$/);
      expect(hit.meta?.siteName).toBe('X');
      expect(Number.isNaN(Date.parse(hit.publishedAt ?? ''))).toBe(false);
    }
  });

  it('keeps author, text, exact time, counts and media of a tweet', () => {
    expect(hits[0]).toMatchObject({
      title: 'OpenAI (@OpenAI)',
      publishedAt: '2026-11-10T18:06:42.000Z',
      meta: { author: '@OpenAI', comments: 1218, reposts: 2686, votes: 16661, views: 5026349 },
    });
    expect(hits[0].url).toMatch(/^https:\/\/x\.com\/OpenAI\/status\/\d+$/);
    expect(hits[0].snippet).toMatch(/^Now in beta: Businesses in ChatGPT\./);
    expect(hits[0].meta?.thumbnail).toMatch(/^https:\/\/pbs\.twimg\.com\//);
  });

  it('takes a quote tweet\'s own words, not the tweet it quotes', () => {
    const quote = hits.find((hit) => hit.meta?.author === '@lidangzzz');
    expect(quote?.snippet).toMatch(/^太好了。/);
    expect(quote?.snippet).not.toContain('Fable');
    expect(quote?.title).toMatch(/^lidang 立党/);
  });

  it('skips promoted tweets and ones without a permalink, reads singular counts, and copes with media-only tweets', () => {
    const tweet = (inner: string, time = '<a href="/someone/status/123"><time datetime="2026-01-02T03:04:05.000Z">Jan 2</time></a>') =>
      `<article data-testid="tweet"><div data-testid="User-Name"><a href="/someone"><span><span>Some One</span></span></a>${time}</div>${inner}</article>`;
    const found = x.extract(
      dom(
        tweet('<div data-testid="tweetText"><span>Hello</span></div><div role="group" aria-label="1 reply, 1 repost, 1 like, 1 view"></div>') +
          tweet('<span>Ad</span><div data-testid="tweetText"><span>Buy now</span></div>', '<a href="/brand/status/9"><time datetime="2026-01-02T03:04:05.000Z">Jan 2</time></a>') +
          tweet('<div data-testid="tweetText"><span>No link</span></div>', '<time datetime="2026-01-02T03:04:05.000Z">Jan 2</time>') +
          tweet('<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/abc?format=jpg"></div>', '<a href="/someone/status/124/photo/1?x=1"><time datetime="2026-01-03T00:00:00.000Z">Jan 3</time></a>'),
      ),
      PAGE,
      'x',
    );
    expect(found.map((hit) => hit.url)).toEqual(['https://x.com/someone/status/123', 'https://x.com/someone/status/124']);
    expect(found[0]).toMatchObject({ snippet: 'Hello', meta: { comments: 1, reposts: 1, votes: 1, views: 1 } });
    expect(found[1]).toMatchObject({ snippet: '', content: undefined, meta: { thumbnail: 'https://pbs.twimg.com/media/abc?format=jpg' } });
  });

  it('reads an X Article (no tweet text, just a cover with a title and a preview) as its title and preview', () => {
    const article = `<article data-testid="tweet"><div data-testid="User-Name"><a href="/EianLu"><span><span>Eian</span></span></a><a href="/EianLu/status/2118317430665613741"><time datetime="2026-11-05T01:02:03.000Z">Nov 5</time></a></div>
      <div><div data-testid="article-cover-image"><div dir="ltr"><div role="img"><span dir="ltr">Article</span></div></div></div>
      <div><div><div dir="auto"><span>Claude code/Codex+Seedance AI视频：从一个想法到成片的全流程</span></div></div><div dir="auto"><span>这篇文章只解决一个问题：怎么用尽量少的钱做出一条自己的视频</span></div></div></div>
      <div role="group" aria-label="833 replies, 6400 reposts, 36000 likes, 5400000 views"></div></article>`;
    const [hit] = x.extract(dom(article), PAGE, 'x');
    expect(hit.url).toBe('https://x.com/EianLu/status/2118317430665613741');
    expect(hit.snippet).toBe('Claude code/Codex+Seedance AI视频：从一个想法到成片的全流程 — 这篇文章只解决一个问题：怎么用尽量少的钱做出一条自己的视频');
    expect(hit.snippet).not.toContain('Article');
    expect(hit.meta).toMatchObject({ comments: 833, votes: 36000, views: 5400000 });
  });

  it('builds the search URL, waits for a tweet, and treats the onboarding redirect as signed out', () => {
    expect(x.buildUrl('红楼梦 openai', 10, 'x')).toBe('https://x.com/search?q=%E7%BA%A2%E6%A5%BC%E6%A2%A6%20openai&src=typed_query');
    expect(dom(fixture('x.html')).querySelector(x.readySelector)).not.toBeNull();
    expect(dom(fixture('x.html')).querySelector(x.blockedSelector)).toBeNull();
    expect(x.isBlockedUrl?.('https://x.com/i/jf/onboarding/web')).toBe(true);
    expect(x.isBlockedUrl?.('https://x.com/i/flow/login')).toBe(true);
    expect(x.isBlockedUrl?.(PAGE)).toBe(false);
    expect(x.matches).toEqual(expect.arrayContaining(['*://x.com/search*', '*://x.com/i/jf/onboarding*']));
    expect(x.minIntervalMs).toBeGreaterThan(DEFAULT_CONFIG.renderer.minIntervalMs);
  });
});

describe('the X mode', () => {
  it('is a tab of its own that is shown as it is: no judging, no summary, and never an automatic route', () => {
    expect(SEARCH_MODES).toContain('x');
    expect(modeHasText('x')).toBe(false);
    expect(resultCount(DEFAULT_CONFIG, 'x')).toBe(10);
    expect(usableSources(DEFAULT_CONFIG, true, 'x').filter((s) => !s.reason).map((s) => s.id)).toEqual(['x']);
    expect(usableSources(DEFAULT_CONFIG, true, 'web').filter((s) => !s.reason).map((s) => s.id)).not.toContain('x');
    expect((ROUTES as string[]).includes('x')).toBe(false);
  });

  it('searches X on request only, and a general search never starts it, whatever the decision model says', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = id === 'google' || id === 'x';
    config.judge.apiKey = '{{SECRET_typesafe01}}';
    config.summary.enabled = true;
    const asked: string[] = [];
    const env: Env = {
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { questions?: Record<string, unknown> };
        if (body.questions && 'zhihu' in body.questions) {
          return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: 'noul', noul: 0.99 }])) }));
        }
        if (body.questions) return new Response(JSON.stringify({ answers: { relevance: { type: 'score', score: 3 }, junk: { type: 'noul', noul: 0.05 } } }));
        throw new Error(`unexpected fetch ${input}`);
      },
      runBrowserEngine: async (engine, _query, opts) => {
        asked.push(`${engine.id}:${opts.mode}`);
        return [{ source: engine.id, url: `https://${engine.id}.example/1`, title: engine.id, snippet: 'text', rank: 1 }];
      },
    };
    await runSearch('openai', config, env);
    expect(asked).toEqual(['google:web']);
    asked.length = 0;
    const events: PipelineEvent[] = [];
    const result = await runSearch('openai', config, env, { mode: 'x', onEvent: (event) => events.push(event) });
    expect(asked).toEqual(['x:x']);
    expect(result.mode).toBe('x');
    const types = events.map((event) => event.type);
    expect(types).not.toContain('judged');
    expect(types.some((type) => type.startsWith('summary'))).toBe(false);
  });
});
