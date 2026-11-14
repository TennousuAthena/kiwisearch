import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { google } from '../src/engines/google';
import { cleanText, makeBrowserSource } from '../src/engines/shared';
import type { Env, FetchLike, RedirectTarget, SearchHit } from '../src/types';
import { sourceContext } from './helpers';

const hit = (url: string, rank = 1): SearchHit => ({
  url,
  title: 'Google result',
  snippet: '',
  source: 'google',
  rank,
});

function responseAt(url: string, body = '', status = 200): Response {
  const response = new Response(body, { status });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

describe('Google snippets', () => {
  const extract = (html: string) => {
    const window = new Window();
    window.document.write(html);
    return google.extract(window.document as unknown as ParentNode, 'https://www.google.com/search', 'web');
  };

  it('leaves out the inline script Google puts inside a snippet (it used to come back as the snippet\'s text)', () => {
    const [result] = extract(`
      <div id="search"><div class="MjjYud">
        <a href="https://hk.trip.com/travel-guide/destination/xingyi-519"><h3>興義旅遊攻略（2026）</h3></a>
        <div class="VwiC3b">興義悅棲裏·山及民宿 <span>萬峯林景區</span> 郭記魚號·金州長壽魚館總店
          <script nonce="x">(function(){ (this||self).Bqpk9e=function(f,d,n,e,k,p){var g=document.getElementById(f);}; }).call(this);</script>
          <style>.pQXcHc{color:red}</style><noscript>enable javascript</noscript>
          <script>var id='_1mX1auqlEsaF9u8P_';</script>
        </div>
      </div></div>`);
    expect(result.snippet).toBe('興義悅棲裏·山及民宿 萬峯林景區 郭記魚號·金州長壽魚館總店');
  });
});

describe('cleanText', () => {
  const text = (html: string) => {
    const window = new Window();
    window.document.write(`<div id="x">${html}</div>`);
    return cleanText(window.document.getElementById('x') as unknown as Element);
  };

  it('reads what a reader sees: nested elements joined, whitespace collapsed, code and hidden markup left out', () => {
    expect(text('  a <b>b\n</b>  <i><u>c</u></i> ')).toBe('a b c');
    expect(text('keep<script>alert(1)</script> <style>p{}</style>this<template><p>no</p></template><noscript>no</noscript>')).toBe('keep this');
    expect(text('<div><div><script>deep()</script>deeper</div></div>')).toBe('deeper');
    expect(text('<script>only code</script>')).toBe('');
    expect(cleanText(null)).toBe('');
  });
});

describe('Google result links', () => {
  it('uses the first valid cite URL as the host for unresolved wrappers', () => {
    const window = new Window();
    window.document.write(`
      <div id="search">
        <div class="MjjYud"><a href="/goto?url=fixture"><h3>Wrapped page</h3></a><cite>https://www.example.com › resources › article</cite></div>
        <div class="MjjYud"><a href="/goto?url=dated"><h3>Dated page</h3></a><cite>2 years ago</cite></div>
        <div class="MjjYud"><a href="/url?q=https%3A%2F%2Fexample.com%2Fdirect"><h3>Direct page</h3></a><cite>https://www.example.com</cite></div>
      </div>
    `);
    const hits = google.extract(window.document as unknown as ParentNode, 'https://www.google.com/search', 'web');
    expect(hits.map((result) => result.host)).toEqual(['example.com', undefined, undefined]);
  });

  it('keeps unwrapping /url?q= links during extraction', () => {
    const window = new Window();
    window.document.write('<div id="search"><a href="/url?q=https%3A%2F%2Fexample.com%2Farticle"><h3>Article</h3></a></div>');
    const hits = google.extract(window.document as unknown as ParentNode, 'https://www.google.com/search', 'web');
    expect(hits[0].url).toBe('https://example.com/article');
  });

  it('resolves a moved page from the first HTTP anchor in the response body', async () => {
    const fetch: FetchLike = async () =>
      new Response('<TITLE>302 Moved</TITLE><A HREF="https://example.com/article?a=1&amp;b=2">here</A>');
    const hits = await google.resolve!([hit('https://www.google.com/goto?url=fixture-redirect-1')], {
      fetch,
      signal: new AbortController().signal,
    });
    expect(hits[0].url).toBe('https://example.com/article?a=1&b=2');
  });

  it('keeps the wrapper when an anchor is on a meta-refresh throttling page', async () => {
    const wrapper = 'https://www.google.com/goto?url=fixture-redirect-1';
    const fetch: FetchLike = async () =>
      new Response('<meta content="3;url=/goto?url=next-token"><a href="https://example.com/article">here</a>');
    const hits = await google.resolve!([hit(wrapper)], { fetch, signal: new AbortController().signal });
    expect(hits[0].url).toBe(wrapper);
  });

  it('uses the final URL when fetch followed a real redirect', async () => {
    const fetch: FetchLike = async () => responseAt('https://arxiv.org/html/2402.03367v2');
    const hits = await google.resolve!([hit('https://www.google.com/goto?url=fixture-redirect-1')], {
      fetch,
      signal: new AbortController().signal,
    });
    expect(hits[0].url).toBe('https://arxiv.org/html/2402.03367v2');
  });

  it('keeps the original wrapper when fetching fails', async () => {
    const wrapper = 'https://www.google.com/goto?url=fixture-redirect-1';
    const fetch: FetchLike = async () => {
      throw new Error('network error');
    };
    const hits = await google.resolve!([hit(wrapper, 5)], { fetch, signal: new AbortController().signal });
    expect(hits).toEqual([hit(wrapper)]);
  });

  it('uses the address Google redirected to even when that page answers with an error status (real: news and paywalled sites say 401 or 403)', async () => {
    for (const status of [401, 403, 404, 429, 503]) {
      const fetch: FetchLike = async () => {
        const response = new Response('denied', { status });
        Object.defineProperty(response, 'url', { value: 'https://www.wsj.com/articles/example-story' });
        return response;
      };
      const hits = await google.resolve!([hit('https://www.google.com/goto?url=fixture-redirect-1')], { fetch, signal: new AbortController().signal });
      expect(hits[0].url).toBe('https://www.wsj.com/articles/example-story');
    }
  });

  it('still keeps the wrapper when Google itself answers with an error', async () => {
    const wrapper = 'https://www.google.com/goto?url=fixture-redirect-1';
    for (const status of [429, 503]) {
      const fetch: FetchLike = async () => responseAt(wrapper, '<a href="https://example.com/article">here</a>', status);
      const hits = await google.resolve!([hit(wrapper)], { fetch, signal: new AbortController().signal });
      expect(hits[0].url).toBe(wrapper);
    }
  });

  describe('with a redirect target (the extension can read where a link leads without waiting for the page)', () => {
    const wrapper = 'https://www.google.com/goto?url=fixture-redirect-1';
    const never: FetchLike = async () => { throw new Error('the page must not be fetched'); };
    const run = (redirectTarget: RedirectTarget, hits = [hit(wrapper)], signal = new AbortController().signal) =>
      google.resolve!(hits, { fetch: never, signal, redirectTarget });

    it('uses it instead of fetching the page', async () => {
      const asked: string[] = [];
      const hits = await run(async (url) => { asked.push(url); return 'https://www.reuters.com/world/story/'; });
      expect(hits[0].url).toBe('https://www.reuters.com/world/story/');
      expect(asked).toEqual([wrapper]);
    });

    it('keeps the wrapper when it finds no redirect, and does not fetch the page instead', async () => {
      const hits = await run(async () => undefined);
      expect(hits[0].url).toBe(wrapper);
    });

    it('keeps the wrapper when it fails', async () => {
      const hits = await run(async () => { throw new Error('webRequest is gone'); });
      expect(hits[0].url).toBe(wrapper);
    });

    it('does not take an address on Google, or one that is not a web address, for the destination', async () => {
      for (const target of ['https://www.google.com/sorry/index?continue=x', 'https://consent.google.com/ml?continue=x', 'javascript:alert(1)', 'chrome-extension://abc/page.html']) {
        const hits = await run(async () => target);
        expect(hits[0].url).toBe(wrapper);
      }
    });

    it('is given a signal that stops it after the redirect timeout and when the search is aborted', async () => {
      const signals: AbortSignal[] = [];
      const parent = new AbortController();
      await run(async (_url, signal) => { signals.push(signal); return undefined; }, [hit(wrapper)], parent.signal);
      expect(signals[0].aborted).toBe(false);
      let seen: AbortSignal | undefined;
      const pending = run((_url, signal) => { seen = signal; return new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined), { once: true })); }, [hit(wrapper)], parent.signal);
      parent.abort();
      expect((await pending)[0].url).toBe(wrapper);
      expect(seen?.aborted).toBe(true);
    });

    it('resolves each wrapper, leaves direct links alone and de-duplicates what several wrappers lead to', async () => {
      const targets: Record<string, string> = {
        'https://www.google.com/goto?url=a': 'https://example.com/story?utm_source=google',
        'https://www.google.com/goto?url=b': 'https://example.com/story',
        'https://www.google.com/goto?url=c': 'https://other.example.org/page',
      };
      const asked: string[] = [];
      const hits = await run(async (url) => { asked.push(url); return targets[url]; }, [
        hit('https://www.google.com/goto?url=a', 1),
        hit('https://www.google.com/goto?url=b', 2),
        hit('https://direct.example.net/page', 3),
        hit('https://www.google.com/goto?url=c', 4),
      ]);
      expect(hits.map((item) => item.url)).toEqual(['https://example.com/story?utm_source=google', 'https://direct.example.net/page', 'https://other.example.org/page']);
      expect(hits.map((item) => item.rank)).toEqual([1, 2, 3]);
      expect(asked).not.toContain('https://direct.example.net/page');
    });

    it('is passed on from the environment by the browser source', async () => {
      const env: Env = {
        fetch: never,
        redirectTarget: async () => 'https://example.com/resolved',
        runBrowserEngine: async () => [hit(wrapper)],
      };
      const hits = await makeBrowserSource(google).search('query', sourceContext(env, { enabled: true }, { count: 10 }));
      expect(hits[0].url).toBe('https://example.com/resolved');
    });
  });

  it('deduplicates resolved URLs and renumbers ranks', async () => {
    const fetch: FetchLike = async (input) =>
      responseAt(
        new URL(input).searchParams.get('url') === 'fixture-redirect-1'
          ? 'https://example.com/article?utm_source=google'
          : 'https://example.com/article',
      );
    const hits = await google.resolve!(
      [
        hit('https://www.google.com/goto?url=fixture-redirect-1', 4),
        hit('https://www.google.com/goto?url=fixture-redirect-2', 9),
      ],
      { fetch, signal: new AbortController().signal },
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://example.com/article?utm_source=google');
    expect(hits[0].rank).toBe(1);
  });

  it('limits redirect lookups to five concurrent requests', async () => {
    let active = 0;
    let maximumActive = 0;
    const fetch: FetchLike = async (input) => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      const redirect = new URL(input).searchParams.get('url');
      return responseAt(`https://example.com/${redirect}`);
    };
    const inputs = Array.from({ length: 9 }, (_, index) => hit(`https://www.google.com/goto?url=fixture-${index}`));
    await google.resolve!(inputs, { fetch, signal: new AbortController().signal });
    expect(maximumActive).toBeLessThanOrEqual(5);
  });

  it('keeps distinct news URLs that mention the same DOI while collapsing URL tracking variants', async () => {
    const urls = [
      'https://publisher.example/news/10.1234/story',
      'https://another.example/report/10.1234/story',
      'https://publisher.example/news/10.1234/story?utm_source=google',
    ];
    const news = { timeKind: 'unknown' as const, retrievedAt: '2026-11-13T00:00:00.000Z' };
    const hits = await google.resolve!(urls.map((url, i) => ({ ...hit(url, i + 4), news })), {
      fetch: async () => { throw new Error('direct URLs must not be fetched'); },
      signal: new AbortController().signal,
    });
    expect(hits.map((item) => item.url)).toEqual(urls.slice(0, 2));
    expect(hits.map((item) => item.rank)).toEqual([1, 2]);
    expect(hits.every((item) => item.news === news)).toBe(true);
  });

  it('runs Google resolution through the browser source with Env.fetch', async () => {
    const wrapper = 'https://www.google.com/goto?url=fixture-redirect-1';
    const env: Env = {
      fetch: async () => new Response('<a href="https://example.com/resolved">here</a>'),
      runBrowserEngine: async () => [hit(wrapper)],
    };
    const source = makeBrowserSource(google);
    const hits = await source.search('query', sourceContext(env, { enabled: true }, { count: 10 }));
    expect(hits[0].url).toBe('https://example.com/resolved');
    expect(hits[0].source).toBe('google');
    expect(hits[0].rank).toBe(1);
  });
});
