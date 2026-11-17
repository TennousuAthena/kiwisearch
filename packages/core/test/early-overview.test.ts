import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { forgetStreamQuirks } from '../src/llm';
import { buildSufficiencyRequest, citesHidden } from '../src/earlyOverview';
import { runSearch } from '../src/pipeline';
import type { Env, FusedResult, FusionConfig, PipelineEvent, SearchHit, SourceId } from '../src/types';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const CHAT = 'https://api.deepseek.com/v1/chat/completions';
const DECISION = 'https://api.typesafe.ai/v1/systemone';

const streamed = (text: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );

/** Three quick sources with text and one slow one; overview on, no decision model unless a test sets one. */
function configFor(early: Partial<FusionConfig['summary']['early']> = {}): FusionConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  const enabled: SourceId[] = ['google', 'bing', 'duckduckgo', 'bravesearch'];
  for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = enabled.includes(id as SourceId);
  config.rerank.provider = 'none';
  config.judge.provider = 'none';
  config.intent.enabled = false;
  config.summary.enabled = true;
  config.summary.contentFetcher = 'none';
  config.llm.apiKey = 'test-key';
  config.summary.early = { ...config.summary.early, minSources: 3, waitMs: 1000, decideMs: 0, ...early };
  return config;
}

function withDecisionModel(config: FusionConfig): FusionConfig {
  config.judge.provider = 'systemone';
  config.judge.apiKey = 'test-judge-key';
  config.judge.fallbackToLlm = false;
  return config;
}

const hit = (source: SourceId, n: number, title = `${source} ${n}`): SearchHit => ({ source, url: `https://${source}.example/${n}`, title, snippet: `${title} snippet`, rank: n });

interface WorldOptions {
  /** How long each source takes; `bravesearch` defaults to the slow one. */
  ms?: Partial<Record<SourceId, number>>;
  /** The decision model's answer to the sufficiency question; `status` makes every decision request fail. */
  sufficient?: number;
  status?: number;
  /** Results judged as junk, by title. */
  junk?: string[];
  /** Titles of each source's results. */
  titles?: Partial<Record<SourceId, string[]>>;
  /** Hold every overview stream until this resolves. */
  hold?: Promise<void>;
  /** Answers a request for a result page (needs `contentFetcher: 'direct'`); the signal is the request's own. */
  onPage?: (url: string, signal?: AbortSignal | null) => Promise<Response>;
}

function world(opts: WorldOptions = {}) {
  const chats: string[] = [];
  const chatBodies: Record<string, unknown>[] = [];
  const sufficiency: unknown[] = [];
  const fetch: Env['fetch'] = async (input, init) => {
    init?.signal?.throwIfAborted();
    if (input === CHAT) {
      const text = chats.length ? 'Final' : 'Early';
      chats.push(text);
      chatBodies.push(JSON.parse(String(init?.body)));
      if (opts.hold) await opts.hold;
      init?.signal?.throwIfAborted();
      return streamed(text);
    }
    // The result pages the sources return (`https://google.example/1`).
    if (opts.onPage && /^https:\/\/[a-z]+\.example\/\d+$/.test(input)) return opts.onPage(input, init?.signal);
    if (input !== DECISION) throw new Error(`unexpected fetch ${input}`);
    if (opts.status) return new Response('nope', { status: opts.status });
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state: { result?: { title?: string } } };
    if ('sufficient' in body.questions) {
      sufficiency.push(body);
      return new Response(JSON.stringify({ answers: { sufficient: { type: 'noul', noul: opts.sufficient ?? 0.9 } } }));
    }
    const junk = opts.junk?.includes(body.state.result?.title ?? '') ? 0.95 : 0.02;
    return new Response(JSON.stringify({ answers: { relevance: { type: 'score', score: 3 }, junk: { type: 'noul', noul: junk } } }));
  };
  const env: Env = {
    fetch,
    runBrowserEngine: async (engine) => {
      const id = engine.id as SourceId;
      await delay(opts.ms?.[id] ?? (id === 'bravesearch' ? 60 : 5));
      return (opts.titles?.[id] ?? [`${id} 1`, `${id} 2`]).map((title, i) => hit(id, i + 1, title));
    },
  };
  return { env, chats, chatBodies, sufficiency };
}

beforeEach(() => forgetStreamQuirks());

const types = (events: PipelineEvent[]) => events.map((event) => `${event.type}${'phase' in event && event.phase ? `:${event.phase}` : ''}`);

describe('the early overview', () => {
  it('starts once three sources have text, while a slower one still runs, and is replaced when no decision model can check it', async () => {
    const { env, chats } = world();
    const events: PipelineEvent[] = [];
    const result = await runSearch('query', configFor(), env, { softDeadlineMs: 500, onEvent: (event) => events.push(event) });
    const seen = types(events);
    const early = seen.indexOf('summary_start:preliminary');
    expect(early).toBeGreaterThanOrEqual(0);
    // Written before the slow source was in: from the three quick ones only.
    expect(early).toBeLessThan(events.findIndex((event) => event.type === 'source_done' && event.source === 'bravesearch'));
    const start = events[early];
    if (start.type === 'summary_start') expect(start.citations.some((citation) => citation.url.includes('bravesearch'))).toBe(false);
    expect(events.find((event) => event.type === 'summary_checked')).toMatchObject({ keep: false, reason: 'no-model' });
    expect(seen.indexOf('summary_done:preliminary')).toBeLessThan(seen.indexOf('summary_start:final'));
    expect(seen.indexOf('summary_done:final')).toBeLessThan(seen.indexOf('done'));
    expect(chats).toEqual(['Early', 'Final']);
    expect(result.summary).toBe('Final');
    expect(result.citations.some((citation) => citation.url.includes('bravesearch'))).toBe(true);
  });

  it('starts after the wait with fewer sources, as soon as one has text', async () => {
    const { env } = world({ ms: { google: 5, bing: 120, duckduckgo: 120, bravesearch: 120 } });
    const events: PipelineEvent[] = [];
    await runSearch('query', configFor({ waitMs: 20 }), env, { softDeadlineMs: 500, onEvent: (event) => events.push(event) });
    const start = events.find((event) => event.type === 'summary_start' && event.phase === 'preliminary');
    expect(start?.type === 'summary_start' && start.citations.map((citation) => new URL(citation.url).host)).toEqual(['google.example', 'google.example']);
    expect(types(events).indexOf('summary_start:preliminary')).toBeLessThan(events.findIndex((event) => event.type === 'source_done' && event.source === 'bing'));
  });

  it('is not written for a caller without a soft deadline (MCP), nor when switched off, nor after the cutoff', async () => {
    for (const [config, softDeadlineMs] of [[configFor(), undefined], [configFor({ enabled: false }), 500], [configFor({ minSources: 9 }), 30]] as const) {
      const { env, chats } = world();
      const events: PipelineEvent[] = [];
      const result = await runSearch('query', config, env, { softDeadlineMs, onEvent: (event) => events.push(event) });
      expect(events.some((event) => event.type === 'summary_checked' || ('phase' in event && event.phase))).toBe(false);
      expect(chats).toEqual(['Early']);
      expect(result.summary).toBe('Early');
    }
  });

  it('stands when the decision model finds it sufficient: one overview request, and the result carries it', async () => {
    const { env, chats, sufficiency } = world({ sufficient: 0.9 });
    const events: PipelineEvent[] = [];
    const result = await runSearch('query', withDecisionModel(configFor()), env, { softDeadlineMs: 500, onEvent: (event) => events.push(event) });
    expect(events.find((event) => event.type === 'summary_checked')).toMatchObject({ keep: true, reason: 'sufficient', score: 0.9 });
    expect(types(events).some((type) => type.endsWith(':final'))).toBe(false);
    expect(chats).toEqual(['Early']);
    expect(result.summary).toBe('Early');
    expect(result.citations.some((citation) => citation.url.includes('bravesearch'))).toBe(false);
    // The model was shown the overview and what it cites.
    expect(sufficiency[0]).toMatchObject({ state: { query: 'query', overview: 'Early', evidence: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }] } });
  });

  it('is replaced when the decision model finds it insufficient, cannot answer, or a result it cites is judged junk', async () => {
    const cases: [WorldOptions, string][] = [
      [{ sufficient: 0.2 }, 'insufficient'],
      [{ status: 500 }, 'error'],
      [{ sufficient: 0.95, junk: ['google 1'] }, 'hidden'],
    ];
    for (const [opts, reason] of cases) {
      const { env, chats } = world(opts);
      const events: PipelineEvent[] = [];
      const result = await runSearch('query', withDecisionModel(configFor()), env, { softDeadlineMs: 500, onEvent: (event) => events.push(event) });
      expect(events.find((event) => event.type === 'summary_checked')).toMatchObject({ keep: false, reason });
      expect(chats).toEqual(['Early', 'Final']);
      expect(result.summary).toBe('Final');
    }
  });

  it('asks no earlier than `decideMs` after the search started', async () => {
    const { env } = world({ sufficient: 0.9 });
    const started = Date.now();
    await runSearch('query', withDecisionModel(configFor({ decideMs: 150 })), env, { softDeadlineMs: 500 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('writes no final overview after the user stopped the early one', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { env, chats } = world({ hold });
    const stop = new AbortController();
    const events: PipelineEvent[] = [];
    const running = runSearch('query', configFor(), env, {
      softDeadlineMs: 500, summarySignal: stop.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'summary_start' && event.phase === 'preliminary') setTimeout(() => { stop.abort(); release(); }, 5);
      },
    });
    const result = await running;
    expect(types(events)).toContain('summary_stopped:preliminary');
    expect(events.some((event) => event.type === 'summary_checked' || (event.type === 'summary_start' && event.phase === 'final'))).toBe(false);
    expect(chats).toEqual(['Early']);
    expect(result.summary).toBeUndefined();
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('hands both prompts to the browser built-in model, phase by phase', async () => {
    const config = configFor();
    config.summary.provider = 'chrome-builtin';
    config.llm.apiKey = '';
    const { env, chats } = world();
    const events: PipelineEvent[] = [];
    await runSearch('query', config, env, { softDeadlineMs: 500, onEvent: (event) => events.push(event) });
    expect(types(events).filter((type) => type.startsWith('summary_prompt'))).toEqual(['summary_prompt:preliminary', 'summary_prompt:final']);
    expect(chats).toEqual([]);
  });

  it('checks the built-in overview by its evidence alone', async () => {
    const config = withDecisionModel(configFor());
    config.summary.provider = 'chrome-builtin';
    const { env, sufficiency } = world({ sufficient: 0.9 });
    const events: PipelineEvent[] = [];
    await runSearch('query', config, env, { softDeadlineMs: 500, onEvent: (event) => events.push(event) });
    expect(events.find((event) => event.type === 'summary_checked')).toMatchObject({ keep: true });
    expect(sufficiency[0]).not.toHaveProperty('state.overview');
  });

  it('asks the model not to think for the early overview only, unless that is switched off', async () => {
    const { env, chatBodies } = world();
    await runSearch('query', configFor(), env, { softDeadlineMs: 500 });
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[0]).toMatchObject({ reasoning_effort: 'none', thinking: { type: 'disabled' } });
    expect(chatBodies[1]).not.toHaveProperty('reasoning_effort');
    expect(chatBodies[1]).not.toHaveProperty('thinking');
    forgetStreamQuirks();
    const plain = world();
    const config = configFor();
    config.summary.early.thinking = 'default';
    await runSearch('query', config, plain.env, { softDeadlineMs: 500 });
    expect(plain.chatBodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('reads the pages for the final overview while the early one is still being written, and only once', async () => {
    const page = () => new Response(`<html><body><p>PAGE-MARKER ${'more words about the subject '.repeat(12)}</p></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const reads: string[] = [];
    const { env, chatBodies } = world({
      hold,
      onPage: async (url) => {
        reads.push(url);
        if (!order.includes('pages')) { order.push('pages'); setTimeout(() => { order.push('early released'); release(); }, 20); }
        return page();
      },
    });
    const config = configFor();
    config.summary.contentFetcher = 'direct';
    await runSearch('query', config, env, { softDeadlineMs: 500 });
    // The early overview was held until a page had been asked for: the reads did not wait for it.
    expect(order).toEqual(['pages', 'early released']);
    expect(new Set(reads).size).toBe(reads.length);
    expect(JSON.stringify(chatBodies[0])).not.toContain('PAGE-MARKER');
    expect(JSON.stringify(chatBodies[1])).toContain('PAGE-MARKER');
  });

  it('stops reading pages when the early overview stands', async () => {
    const aborted: string[] = [];
    const { env, chats } = world({
      sufficient: 0.9,
      onPage: (url, signal) => new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { aborted.push(url); reject(new Error('aborted')); }, { once: true });
      }),
    });
    const config = withDecisionModel(configFor());
    config.summary.contentFetcher = 'direct';
    const result = await runSearch('query', config, env, { softDeadlineMs: 500 });
    await delay(20);
    expect(result.summary).toBe('Early');
    expect(chats).toEqual(['Early']);
    expect(aborted.length).toBeGreaterThan(0);
  });

  it('does not wait for or ask the decision model once judging has hidden a result the early overview cites', async () => {
    const { env, sufficiency, chats } = world({ sufficient: 0.95, junk: ['google 1'] });
    const events: PipelineEvent[] = [];
    const started = Date.now();
    await runSearch('query', withDecisionModel(configFor({ decideMs: 400 })), env, { softDeadlineMs: 500, onEvent: (event) => events.push(event) });
    expect(Date.now() - started).toBeLessThan(300);
    expect(events.find((event) => event.type === 'summary_checked')).toMatchObject({ keep: false, reason: 'hidden' });
    expect(sufficiency).toHaveLength(0);
    expect(chats).toEqual(['Early', 'Final']);
  });

  it('keeps a news overview time anchored to the overview the page shows', async () => {
    const config = configFor();
    config.sources = { google: { enabled: true }, bing: { enabled: true }, bravesearch: { enabled: true } };
    const { env } = world({ ms: { google: 5, bing: 5, bravesearch: 5 } });
    const result = await runSearch('query', config, env, { mode: 'news', softDeadlineMs: 500 });
    expect(result.news?.summaryAt).toBeDefined();
    expect(Date.parse(result.news!.summaryAt!)).toBeGreaterThanOrEqual(Date.parse(result.news!.requestedAt));
  });
});

describe('the sufficiency question', () => {
  const result = (url: string, hidden = false): FusedResult => ({ key: url, url, title: url, snippet: 'x'.repeat(900), sources: [], rrfScore: 1, score: 1, meta: {}, ...(hidden ? { hidden: { reason: 'junk' } } : {}) });

  it('clips long text and numbers the evidence as the overview cites it', () => {
    const request = buildSufficiencyRequest('q', 'o'.repeat(9000), [result('https://a.example'), result('https://b.example')], 'jev-latest');
    expect(request.state.overview).toHaveLength(4000);
    expect(request.state.evidence.map((item) => [item.n, item.excerpt.length])).toEqual([[1, 400], [2, 400]]);
    expect(Object.keys(request.questions)).toEqual(['sufficient']);
  });

  it('notices a cited result that judging hid', () => {
    const citations = [{ n: 1, url: 'https://a.example', title: 'a' }];
    expect(citesHidden(citations, [result('https://a.example', true)])).toBe(true);
    expect(citesHidden(citations, [result('https://a.example'), result('https://b.example', true)])).toBe(false);
  });
});
