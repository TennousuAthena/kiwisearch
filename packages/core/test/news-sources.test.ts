import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { brave } from '../src/sources/brave';
import { exa } from '../src/sources/exa';
import { sourceContext } from './helpers';
import type { FetchLike, NewsRange } from '../src/types';

const NOW = new Date('2026-11-13T00:00:00Z');
function response(name: string) {
  const payload = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  };
  return { env: { fetch }, calls };
}

afterEach(() => vi.useRealTimers());

describe('news API source contracts (hand-written fixtures)', () => {
  it('uses Brave News results and preserves ambiguous page age without treating fetch time as publication', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { env, calls } = response('brave-news');
    const hits = await brave.search('a & b', { ...sourceContext(env, { enabled: true, apiKey: 'fixture-key' }), mode: 'news', news: { range: 'day', sort: 'date' }, count: 80 });
    const url = new URL(calls[0].input);
    expect(url.pathname).toBe('/res/v1/news/search');
    expect(url.searchParams.get('q')).toBe('a & b');
    expect(url.searchParams.get('freshness')).toBe('pd');
    expect(url.searchParams.get('count')).toBe('50');
    expect(new Headers(calls[0].init?.headers).get('X-Subscription-Token')).toBe('fixture-key');
    expect(hits[0]).toMatchObject({ title: 'A news headline', snippet: 'A reported event.', content: 'One excerpt\nAnother excerpt', source: 'brave', news: { publisher: 'Example Daily', timeText: '10 hours ago', timeKind: 'unknown', retrievedAt: NOW.toISOString(), thumbnail: 'https://images.example/news.jpg' } });
    expect(hits.every((hit) => hit.publishedAt === undefined && hit.news?.updatedAt === undefined)).toBe(true);
    expect(hits[1].news?.thumbnail).toBeUndefined();
    expect(hits[1].news?.timeText).toBeUndefined();
  });

  it.each<[NewsRange, string | null]>([['any', null], ['day', 'pd'], ['week', 'pw'], ['month', 'pm']])('maps Brave range %s to its native freshness filter', async (range, expected) => {
    const { env, calls } = response('brave-news');
    await brave.search('news', { ...sourceContext(env, { enabled: true }), mode: 'news', news: { range, sort: 'relevance' } });
    expect(new URL(calls[0].input).searchParams.get('freshness')).toBe(expected);
  });

  it('uses Exa news category and publication cutoff, preserving news bylines without paper metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { env, calls } = response('exa-news');
    const hits = await exa.search('news query', { ...sourceContext(env, { enabled: true, apiKey: 'fixture-key' }), mode: 'news', news: { range: 'week', sort: 'date' } });
    expect(calls[0].input).toBe('https://api.exa.ai/search');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ query: 'news query', category: 'news', startPublishedDate: '2026-11-06T00:00:00.000Z' });
    expect(hits[0]).toMatchObject({ publishedAt: '2026-11-12T14:00:00.000Z', snippet: 'A reported event.', meta: { author: 'Ada Reporter' }, news: { byline: 'Ada Reporter', timeKind: 'published', retrievedAt: NOW.toISOString(), thumbnail: 'https://images.example/story.jpg' } });
    expect(hits.every((hit) => hit.meta?.authors === undefined)).toBe(true);
    expect(hits[1]).toMatchObject({ publishedAt: '2026-11-11', news: { timePrecision: 'day' } });
    expect(hits[2].publishedAt).toBeUndefined();
    expect(hits[2].news?.thumbnail).toBeUndefined();
  });

  it('leaves the publication cutoff unset for any-time Exa news', async () => {
    const { env, calls } = response('exa-news');
    await exa.search('news', { ...sourceContext(env, { enabled: true }), mode: 'news' });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.category).toBe('news');
    expect(body.startPublishedDate).toBeUndefined();
  });
});
