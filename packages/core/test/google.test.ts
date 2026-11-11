import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { google } from '../src/engines/google';
import { makeBrowserSource } from '../src/engines/shared';
import type { Env, FetchLike, SearchHit } from '../src/types';
import { sourceContext } from './helpers';

const hit = (url: string, rank = 1): SearchHit => ({
  url,
  title: 'Google result',
  snippet: '',
  source: 'google',
  rank,
});

function responseAt(url: string, body = ''): Response {
  const response = new Response(body);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

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
