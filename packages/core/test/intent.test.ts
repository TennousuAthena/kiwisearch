import { describe, expect, it } from 'vitest';
import { createSourceCache } from '../src/cache';
import { DEFAULT_CONFIG, sourcesForRoutes } from '../src/config';
import { ROUTES, buildIntentRequest, judgeIntent, suggestionFrom } from '../src/intent';
import { runSearch } from '../src/pipeline';
import type { Env, FusionConfig, PipelineEvent, SearchHit } from '../src/types';

const KEY = '{{SECRET_typesafe01}}';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function configFor(...enabled: string[]): FusionConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = enabled.includes(id);
  config.judge.provider = 'systemone';
  config.judge.apiKey = KEY;
  config.summary.enabled = false;
  config.rerank.provider = 'none';
  return config;
}

const hit = (source: SearchHit['source'], url: string, rank = 1, extra: Partial<SearchHit> = {}): SearchHit => ({
  source,
  url,
  title: `${source} result`,
  snippet: `${source} snippet`,
  rank,
  ...extra,
});

type Verdict = Partial<Record<'academic' | 'zhihu' | 'xiaohongshu' | 'wechat' | 'images' | 'video', number>>;

/** A fake System One + OpenAlex. Intent requests (they carry the route questions) are answered from `verdict`; judging requests get a flat "relevant". */
function world(verdict: Verdict, opts: { delayMs?: number; status?: number } = {}) {
  const intentRequests: unknown[] = [];
  const asked: { engine: string; mode: string; count: number }[] = [];
  const openalex: string[] = [];
  const fetch: Env['fetch'] = async (input, init) => {
    init?.signal?.throwIfAborted(); // a real fetch rejects at once when the signal is already aborted
    if (input.startsWith('https://api.openalex.org')) {
      openalex.push(input);
      return new Response(JSON.stringify({ results: [{ id: 'https://openalex.org/W1', display_name: 'An academic paper', publication_year: 2020 }] }));
    }
    if (!input.startsWith('https://api.typesafe.ai')) throw new Error(`unexpected fetch ${input}`);
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state: unknown };
    const isIntent = 'zhihu' in body.questions;
    if (isIntent) intentRequests.push(body);
    if (isIntent && opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.delayMs);
        init?.signal?.addEventListener('abort', () => (clearTimeout(timer), reject(init.signal!.reason)), { once: true });
      });
    }
    if (opts.status) return new Response('nope', { status: opts.status });
    if (isIntent) {
      const answers = Object.fromEntries([...ROUTES, 'images', 'video'].map((key) => [key, { type: 'noul', noul: verdict[key as keyof Verdict] ?? 0.02 }]));
      return new Response(JSON.stringify({ answers }));
    }
    return new Response(JSON.stringify({ answers: { relevance: { type: 'score', score: 3 }, junk: { type: 'noul', noul: 0.05 } } }));
  };
  const env: Env = {
    fetch,
    runBrowserEngine: async (engine, _query, runOpts) => {
      asked.push({ engine: engine.id, mode: runOpts.mode, count: runOpts.count });
      return [hit(engine.id, `https://${engine.id}.example/page`)];
    },
  };
  return { env, intentRequests, asked, openalex };
}

describe('judgeIntent', () => {
  const env = (verdict: Verdict): Env => world(verdict).env;

  it('asks six independent yes/no questions about the query alone', () => {
    const request = buildIntentRequest('如何评价红楼梦', 'jev-latest') as { model: string; state: unknown; questions: Record<string, { type: string; criteria?: unknown }> };
    expect(request.model).toBe('jev-latest');
    expect(request.state).toEqual({ query: '如何评价红楼梦' });
    expect(Object.keys(request.questions)).toEqual(['academic', 'zhihu', 'xiaohongshu', 'wechat', 'images', 'video']);
    for (const question of Object.values(request.questions)) expect(question.type).toBe('noul');
  });

  it('turns on the routes at or above the threshold', async () => {
    const config = configFor();
    expect(await judgeIntent('q', config, env({ academic: 0.59, zhihu: 0.6, xiaohongshu: 0.95 }))).toEqual({
      routes: ['zhihu', 'xiaohongshu'],
      scores: { academic: 0.59, zhihu: 0.6, xiaohongshu: 0.95, wechat: 0.02, images: 0.02, video: 0.02 },
    });
  });

  it('points to the images, video or academic tab the user probably wants, and says whether it is sure enough to switch by itself', async () => {
    const config = configFor();
    expect((await judgeIntent('golden retriever puppy photos', config, env({ images: 0.93 }))).suggest).toEqual({ mode: 'images', score: 0.93, strong: true });
    expect((await judgeIntent('q', config, env({ video: 0.7 }))).suggest).toEqual({ mode: 'video', score: 0.7, strong: false });
    expect((await judgeIntent('transformer', config, env({ academic: 0.9 }))).suggest).toEqual({ mode: 'academic', score: 0.9, strong: true });
    expect((await judgeIntent('weather', config, env({ images: 0.5, video: 0.3 }))).suggest).toBeUndefined();
    config.intent.autoSwitch = false;
    expect((await judgeIntent('q', config, env({ images: 0.99 }))).suggest).toMatchObject({ mode: 'images', strong: false });
  });

  it('picks the best-scoring tab, and the first of the list on a tie', () => {
    const intent = { threshold: 0.6, switchThreshold: 0.85, autoSwitch: true };
    expect(suggestionFrom({ images: 0.8, video: 0.9 }, intent)?.mode).toBe('video');
    expect(suggestionFrom({ academic: 0.9, images: 0.9 }, intent)?.mode).toBe('academic');
    expect(suggestionFrom({ zhihu: 0.99 }, intent)).toBeUndefined();
    expect(suggestionFrom({ images: 0.85 }, intent)?.strong).toBe(true);
    expect(suggestionFrom({ images: 0.8499 }, intent)?.strong).toBe(false);
  });

  it('treats a missing answer as a no, and a failure as "no verdict" instead of an error', async () => {
    const config = configFor();
    const missing: Env = { fetch: async () => new Response(JSON.stringify({ answers: { zhihu: { type: 'noul', noul: 0.9 } } })) };
    expect((await judgeIntent('q', config, missing)).routes).toEqual(['zhihu']);
    const failing = world({}, { status: 500 }).env;
    const verdict = await judgeIntent('q', config, failing);
    expect(verdict.routes).toEqual([]);
    expect(verdict.error).toMatch(/500/);
  });

  it('gives up after its own timeout, but lets a cancelled search cancel it', async () => {
    const config = configFor();
    config.intent.timeoutMs = 40;
    const slow = world({ zhihu: 0.9 }, { delayMs: 300 }).env;
    const verdict = await judgeIntent('q', config, slow);
    expect(verdict).toMatchObject({ routes: [] });
    expect(verdict.error).toMatch(/40ms/);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(judgeIntent('q', config, slow, controller.signal)).rejects.toThrow('cancelled');
  });
});

describe('sourcesForRoutes', () => {
  it('picks the enabled sources of each route, and only the ones that can run here', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    expect(sourcesForRoutes(config, true, ['zhihu'])).toEqual(['zhihu']);
    expect(sourcesForRoutes(config, true, ['xiaohongshu'])).toEqual(['rednote']);
    expect(sourcesForRoutes(config, true, ['academic']).sort()).toEqual(['arxiv', 'crossref', 'openalex', 'pubmed', 'scholar']);
    expect(sourcesForRoutes(config, false, ['academic']).sort()).toEqual(['arxiv', 'crossref', 'openalex', 'pubmed']);
    expect(sourcesForRoutes(config, true, ['wechat'])).toEqual(['weixin']);
    expect(sourcesForRoutes(config, false, ['zhihu', 'xiaohongshu', 'wechat'])).toEqual([]);
    config.sources.xiaohongshu = { enabled: true };
    expect(sourcesForRoutes(config, true, ['xiaohongshu']).sort()).toEqual(['rednote', 'xiaohongshu']);
    expect(sourcesForRoutes(config, true, [])).toEqual([]);
  });
});

describe('a general search with routing', () => {
  it('starts the general sources at once, then switches Zhihu on and merges its results', async () => {
    const { env, asked } = world({ zhihu: 0.9 }, { delayMs: 60 });
    const events: PipelineEvent[] = [];
    const result = await runSearch('如何评价红楼梦', configFor('google', 'zhihu', 'rednote'), env, { onEvent: (event) => events.push(event) });
    expect(asked.sort((a, b) => a.engine.localeCompare(b.engine))).toEqual([
      { engine: 'google', mode: 'web', count: 10 },
      { engine: 'zhihu', mode: 'zhihu', count: 10 },
    ]);
    expect(result.results.map((r) => r.url).sort()).toEqual(['https://google.example/page', 'https://zhihu.example/page']);
    const types = events.map((event) => event.type);
    expect(types.indexOf('fused')).toBeLessThan(types.indexOf('routed'));
    expect(events.find((event) => event.type === 'fused')).toMatchObject({ partial: true });
    expect(events.find((event) => event.type === 'routed')).toMatchObject({ routes: ['zhihu'] });
    expect(result.sourceStats.map((s) => s.source).sort()).toEqual(['google', 'zhihu']);
  });

  it('reports the tab it suggests in the routed event, even when nothing extra is searched', async () => {
    const { env, asked } = world({ images: 0.95 });
    const events: PipelineEvent[] = [];
    await runSearch('golden retriever puppy photos', configFor('google', 'zhihu'), env, { onEvent: (event) => events.push(event) });
    expect(events.find((event) => event.type === 'routed')).toMatchObject({ routes: [], suggest: { mode: 'images', score: 0.95, strong: true } });
    expect(asked.map((a) => a.engine)).toEqual(['google']);
  });

  it('starts the academic sources, API and browser alike', async () => {
    const { env, asked, openalex } = world({ academic: 0.95 });
    const result = await runSearch('graph neural network survey', configFor('google', 'openalex', 'scholar'), env);
    expect(asked.map((a) => `${a.engine}:${a.mode}`).sort()).toEqual(['google:web', 'scholar:academic']);
    expect(openalex).toHaveLength(1);
    expect(result.results.map((r) => r.title)).toContain('An academic paper');
  });

  it('uses whichever Xiaohongshu site is switched on, in the notes mode', async () => {
    const one = world({ xiaohongshu: 0.9 });
    await runSearch('杭州三日游攻略', configFor('google', 'rednote'), one.env);
    expect(one.asked.find((a) => a.engine === 'rednote')).toEqual({ engine: 'rednote', mode: 'xiaohongshu', count: 12 });
    const both = world({ xiaohongshu: 0.9 });
    await runSearch('杭州三日游攻略', configFor('google', 'rednote', 'xiaohongshu'), both.env);
    expect(both.asked.map((a) => a.engine).sort()).toEqual(['google', 'rednote', 'xiaohongshu']);
    const off = world({ xiaohongshu: 0.9 });
    await runSearch('杭州三日游攻略', configFor('google'), off.env);
    expect(off.asked.map((a) => a.engine)).toEqual(['google']);
  });

  it('asks nothing extra when the model says no', async () => {
    const { env, asked } = world({ zhihu: 0.4, academic: 0.1 });
    await runSearch('weather today', configFor('google', 'zhihu', 'openalex'), env);
    expect(asked.map((a) => a.engine)).toEqual(['google']);
  });

  it('does not route without a key, when switched off, with explicit sources, or outside the general search', async () => {
    const cases: [string, (config: FusionConfig) => void, Parameters<typeof runSearch>[3]][] = [
      ['no key', (config) => (config.judge.apiKey = ''), {}],
      ['judge off', (config) => (config.judge.provider = 'none'), {}],
      ['intent off', (config) => (config.intent.enabled = false), {}],
      ['explicit sources', () => {}, { sources: ['google'] }],
      ['another mode', () => {}, { mode: 'academic' }],
    ];
    for (const [name, change, runOpts] of cases) {
      const { env, intentRequests } = world({ zhihu: 0.9, academic: 0.9 });
      const config = configFor('google', 'zhihu', 'scholar');
      change(config);
      await runSearch('q', config, env, runOpts);
      expect(intentRequests, name).toHaveLength(0);
    }
  });

  it('keeps going with the general sources when the verdict fails or is too slow, and says so', async () => {
    const failed = world({ zhihu: 0.9 }, { status: 500 });
    const failedEvents: PipelineEvent[] = [];
    const result = await runSearch('q', configFor('google', 'zhihu'), failed.env, { onEvent: (event) => failedEvents.push(event) });
    expect(failed.asked.map((a) => a.engine)).toEqual(['google']);
    expect(result.results).toHaveLength(1);
    expect(failedEvents.find((event) => event.type === 'routed')).toMatchObject({ routes: [], error: expect.stringContaining('500') });

    const slowConfig = configFor('google', 'zhihu');
    slowConfig.intent.timeoutMs = 40;
    const slow = world({ zhihu: 0.9 }, { delayMs: 400 });
    const started = Date.now();
    await runSearch('q', slowConfig, slow.env);
    expect(Date.now() - started).toBeLessThan(300);
    expect(slow.asked.map((a) => a.engine)).toEqual(['google']);
  });

  it('waits past the soft deadline for a slow decision model, and what its verdict starts merges in late', async () => {
    const { env, asked } = world({ zhihu: 0.9 }, { delayMs: 150 });
    const events: PipelineEvent[] = [];
    const result = await runSearch('q', configFor('google', 'zhihu'), env, { softDeadlineMs: 30, onEvent: (event) => events.push(event) });
    expect(events.find((event) => event.type === 'routed')).toMatchObject({ routes: ['zhihu'] });
    expect(result.results).toHaveLength(1); // the general results; Zhihu was only just started
    await delay(250);
    expect(asked.map((a) => a.engine).sort()).toEqual(['google', 'zhihu']);
    expect(events.some((event) => event.type === 'late_results' && event.source === 'zhihu')).toBe(true);
  });

  it('gives up on a decision model that is slower than its own limit, and leaves the general sources', async () => {
    const config = configFor('google', 'zhihu');
    config.intent.timeoutMs = 40;
    const { env, asked } = world({ zhihu: 0.9 }, { delayMs: 400 });
    await runSearch('q', config, env, { softDeadlineMs: 30 });
    await delay(150);
    expect(asked.map((a) => a.engine)).toEqual(['google']);
  });

  it('shares the cache with the platform\'s own tab', async () => {
    const { env, asked } = world({ zhihu: 0.9 });
    env.cache = createSourceCache();
    const config = configFor('google', 'zhihu');
    await runSearch('红楼梦', config, env);
    await runSearch('红楼梦', config, env, { mode: 'zhihu' });
    expect(asked.filter((a) => a.engine === 'zhihu')).toHaveLength(1);
  });

  it('cites only results that have text, so a photo-only note is not a source', async () => {
    const { env } = world({ xiaohongshu: 0.9 });
    const run = env.runBrowserEngine!;
    env.runBrowserEngine = async (engine, query, opts) =>
      engine.id === 'rednote'
        ? [hit('rednote', 'https://www.rednote.com/search_result/' + 'a'.repeat(24), 1, { snippet: '', note: { cover: 'c' } })]
        : run(engine, query, opts);
    const baseFetch = env.fetch;
    env.fetch = async (input, init) =>
      input.endsWith('/chat/completions')
        ? new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n')
        : baseFetch(input, init);
    const config = configFor('google', 'rednote');
    config.summary.enabled = true;
    config.summary.contentFetcher = 'none';
    config.llm.apiKey = '{{SECRET_llmkey01}}';
    const result = await runSearch('杭州三日游攻略', config, env);
    expect(result.results).toHaveLength(2);
    expect(result.citations.map((c) => c.url)).toEqual(['https://google.example/page']);
  });
});
