import { describe, expect, it } from 'vitest';
import { brave } from '../src/sources/brave';
import { deepseek } from '../src/sources/deepseek';
import { exa } from '../src/sources/exa';
import { openalex } from '../src/sources/openalex';
import { searxng } from '../src/sources/searxng';
import type { FetchLike, SearchSource } from '../src/types';

function mockEnv(payload: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  };
  return { env: { fetch }, calls };
}

async function search(
  source: SearchSource,
  env: ReturnType<typeof mockEnv>['env'],
  settings: { enabled: boolean; apiKey?: string; baseUrl?: string },
) {
  return source.search('fusion query', {
    env,
    settings,
    count: 7,
    signal: new AbortController().signal,
    onBlocked: () => {},
  });
}

describe('official API sources', () => {
  it('sends OpenAlex query and optional key and parses academic metadata', async () => {
    const { env, calls } = mockEnv({
      results: [{
        id: 'https://openalex.org/W1',
        doi: 'https://doi.org/10.1234/test',
        display_name: 'A paper',
        publication_year: 2024,
        cited_by_count: 9,
        authorships: [{ author: { display_name: 'Ada Lovelace' } }],
        primary_location: { source: { display_name: 'Journal' } },
        abstract_inverted_index: { rank: [0], fusion: [1] },
      }],
    });
    const hits = await search(openalex, env, { enabled: true, apiKey: 'oa-key' });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://api.openalex.org/works');
    expect(url.searchParams.get('search')).toBe('fusion query');
    expect(url.searchParams.get('per_page')).toBe('7');
    expect(url.searchParams.get('api_key')).toBe('oa-key');
    expect(hits[0]).toMatchObject({ title: 'A paper', source: 'openalex', rank: 1, meta: { authors: ['Ada Lovelace'], year: 2024, citations: 9 } });
    expect(hits[0].content).toBe('rank fusion');
  });

  it('sends Exa key and search body and parses content', async () => {
    const { env, calls } = mockEnv({ results: [{ title: 'Exa result', url: 'https://exa.example/', text: 'Article text', highlights: ['A useful highlight'] }] });
    const hits = await search(exa, env, { enabled: true, apiKey: 'exa-key' });
    expect(calls[0].url).toBe('https://api.exa.ai/search');
    expect(new Headers(calls[0].init?.headers).get('x-api-key')).toBe('exa-key');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ query: 'fusion query', numResults: 7 });
    expect(hits[0]).toMatchObject({ title: 'Exa result', snippet: 'A useful highlight', content: 'Article text' });
  });

  it('sends DeepSeek authorization and request body and parses results', async () => {
    const { env, calls } = mockEnv({ results: [{ title: 'DeepSeek result', url: 'https://deepseek.example/', snippet: 'Answer', rerank_score: 0.8 }] });
    const hits = await search(deepseek, env, { enabled: true, apiKey: 'deepseek-key' });
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer deepseek-key');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ query: 'fusion query', count: 7 });
    expect(hits[0]).toMatchObject({ title: 'DeepSeek result', snippet: 'Answer', meta: { sourceScore: 0.8 } });
  });

  it('sends Brave token and query parameters and parses snippets', async () => {
    const { env, calls } = mockEnv({ web: { results: [{ title: 'Brave result', url: 'https://brave.example/', description: 'A result' }] } });
    const hits = await search(brave, env, { enabled: true, apiKey: 'brave-key' });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.searchParams.get('q')).toBe('fusion query');
    expect(url.searchParams.get('count')).toBe('7');
    expect(new Headers(calls[0].init?.headers).get('x-subscription-token')).toBe('brave-key');
    expect(hits[0]).toMatchObject({ title: 'Brave result', snippet: 'A result' });
  });

  it('uses configured SearXNG base URL and parses results', async () => {
    const { env, calls } = mockEnv({ results: [{ title: 'SearX result', url: 'https://searx.example/r', content: 'Snippet', engine: 'google' }] });
    const hits = await search(searxng, env, { enabled: true, baseUrl: 'https://searx.example/' });
    expect(calls[0].url).toBe('https://searx.example/search?q=fusion%20query&format=json');
    expect(hits[0]).toMatchObject({ title: 'SearX result', snippet: 'Snippet' });
  });
});
