import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSourceCache } from '../src/cache';
import { DEFAULT_CONFIG } from '../src/config';
import { parseNewsTime } from '../src/news';
import { runSearch } from '../src/pipeline';
import type { Env, FusionConfig, NewsOptions, PipelineEvent, SearchHit, SourceId } from '../src/types';

const now = new Date('2026-11-13T12:00:00Z');
const configFor = (...ids: SourceId[]): FusionConfig => {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const [id, setting] of Object.entries(config.sources)) if (setting) setting.enabled = ids.includes(id as SourceId);
  config.judge.provider = 'none';
  config.rerank.provider = 'none';
  config.summary.enabled = false;
  config.summary.contentFetcher = 'none';
  return config;
};
const hit = (id: string, date?: string): SearchHit => ({
  source: 'google', url: `https://example.org/${id}`, title: id, snippet: `Reporting about ${id}`, rank: 1,
  ...parseNewsTime(date, new Date()),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe('news search pipeline', () => {
  it('isolates source cache by mode, range and order, uses a one-minute TTL and bypasses it on refresh', async () => {
    const asked: { mode: string; news?: NewsOptions }[] = [];
    const env: Env = {
      fetch: async () => { throw new Error('unexpected network call'); },
      cache: createSourceCache(),
      runBrowserEngine: async (_engine, _query, options) => {
        asked.push({ mode: options.mode, news: options.news });
        return [hit('one', '2026-11-13T11:00:00Z')];
      },
    };
    const config = configFor('google');
    const run = (news?: Partial<NewsOptions>, refresh = false) => runSearch('query', config, env, { mode: 'news', news, refresh });
    const first = await run();
    await run();
    expect(asked).toHaveLength(1);
    expect(first.news).toEqual({ range: 'any', sort: 'relevance', requestedAt: now.toISOString() });
    await run({ range: 'day' });
    await run({ range: 'day', sort: 'date' });
    await run({ range: 'day', sort: 'date' }, true);
    expect(asked).toHaveLength(4);
    expect(asked[2]).toEqual({ mode: 'news', news: { range: 'day', sort: 'date' } });
    await runSearch('query', config, env, { mode: 'web' });
    expect(asked).toHaveLength(5);
    expect(asked[4].news).toBeUndefined();
    vi.setSystemTime(now.getTime() + 60_000);
    await run();
    expect(asked).toHaveLength(6);
    await runSearch('query', config, env, { mode: 'web' });
    expect(asked).toHaveLength(6); // Ordinary web results still have a five-minute TTL.
  });

  it.each(['judge', 'rerank'] as const)('keeps date order and time exclusions after %s scoring', async (scoring) => {
    const config = configFor('google');
    if (scoring === 'judge') {
      config.judge.provider = 'systemone';
      config.judge.apiKey = 'test-key';
    } else {
      config.rerank.provider = 'cohere';
      config.rerank.apiKey = 'test-key';
    }
    const env: Env = {
      fetch: async (_url, init) => {
        if (scoring === 'rerank') return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0 }, { index: 1, relevance_score: 1 }] }));
        const request = JSON.parse(String(init?.body));
        expect(request.state.result.title).not.toBe('old');
        expect(request.state.result.title).not.toBe('unknown');
        return new Response(JSON.stringify({ answers: { relevance: { type: 'score', score: request.state.result.title === 'newer' ? 1 : 3 }, junk: { type: 'noul', noul: 0 } } }));
      },
      runBrowserEngine: async () => [hit('older', '2026-11-13T09:00:00Z'), hit('newer', '2026-11-13T11:00:00Z'), hit('old', '2026-11-01T11:00:00Z'), hit('unknown')],
    };
    const result = await runSearch('query', config, env, { mode: 'news', news: { range: 'day', sort: 'date' } });
    expect(result.results.filter((r) => !r.hidden).map((r) => r.title)).toEqual(['newer', 'older']);
    expect(result.results.filter((r) => r.hidden?.reason === 'time')).toHaveLength(2);
  });

  it('filters and sorts partial and late results while preserving the original summary evidence', async () => {
    const config = configFor('google', 'bravesearch');
    config.summary.enabled = true;
    config.summary.provider = 'chrome-builtin';
    const events: PipelineEvent[] = [];
    let release!: (hits: SearchHit[]) => void;
    const slow = new Promise<SearchHit[]>((resolve) => { release = resolve; });
    let reportLate!: (event: Extract<PipelineEvent, { type: 'late_results' }>) => void;
    const late = new Promise<Extract<PipelineEvent, { type: 'late_results' }>>((resolve) => { reportLate = resolve; });
    const env: Env = {
      fetch: async () => { throw new Error('unexpected network call'); },
      runBrowserEngine: async (engine, _query, options) => {
        if (engine.id === 'bravesearch') {
          options.onBlocked('captcha');
          return slow;
        }
        return [hit('initial', '2026-11-13T09:00:00Z'), hit('old', '2026-11-01T09:00:00Z')];
      },
    };
    const result = await runSearch('query', config, env, {
      mode: 'news', news: { range: 'day', sort: 'date' },
      onEvent: (event) => { events.push(event); if (event.type === 'late_results') reportLate(event); },
    });
    expect(result.news?.summaryAt).toBe(now.toISOString());
    expect(result.citations.map((c) => c.url)).toEqual(['https://example.org/initial']);
    expect(events.findIndex((event) => event.type === 'summary_start')).toBeLessThan(events.findIndex((event) => event.type === 'summary_prompt'));
    release([hit('newest', '2026-11-13T11:00:00Z'), hit('unknown')]);
    const merged = await late;
    expect(merged.results.filter((r) => !r.hidden).map((r) => r.title)).toEqual(['newest', 'initial']);
    expect(merged.results.find((r) => r.title === 'unknown')?.hidden).toEqual({ reason: 'time', detail: 'unknown' });
    expect(events.filter((event) => event.type === 'summary_prompt')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'summary_start')).toHaveLength(1);
    expect(result.citations.map((c) => c.url)).toEqual(['https://example.org/initial']);
    for (const event of events) {
      if (event.type === 'fused') expect(event.results.find((r) => r.title === 'old')?.hidden).toEqual({ reason: 'time', detail: 'outside' });
    }
  });

  it('waits past the soft deadline for usable text when the first source only returns old news', async () => {
    const config = configFor('google', 'bravesearch');
    config.summary.enabled = true;
    config.summary.provider = 'chrome-builtin';
    const env: Env = {
      fetch: async () => { throw new Error('unexpected network call'); },
      runBrowserEngine: async (engine) => {
        if (engine.id === 'google') return [hit('old', '2026-11-01T09:00:00Z')];
        await new Promise((resolve) => setTimeout(resolve, 30));
        return [hit('recent', '2026-11-13T11:00:00Z')];
      },
    };
    const events: PipelineEvent[] = [];
    const result = await runSearch('query', config, env, { mode: 'news', news: { range: 'day' }, softDeadlineMs: 5, onEvent: (event) => events.push(event) });
    expect(result.citations.map((citation) => citation.title)).toEqual(['recent']);
    expect(result.results.find((r) => r.title === 'old')?.hidden).toEqual({ reason: 'time', detail: 'outside' });
    expect(events.filter((event) => event.type === 'summary_prompt')).toHaveLength(1);
  });
});
