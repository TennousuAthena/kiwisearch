import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { runSearch } from '../src/pipeline';
import type { Env, FusionConfig, PipelineEvent, SearchHit, SourceId } from '../src/types';

function configFor(...enabled: SourceId[]): FusionConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = enabled.includes(id as SourceId);
  config.rerank.provider = 'none';
  config.summary.enabled = false;
  return config;
}

const hit = (source: SourceId, url: string, title: string): SearchHit => ({ source, url, title, snippet: `${title} snippet`, rank: 1 });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('runSearch', () => {
  it('emits done before results from a blocked source', async () => {
    const config = configFor('google');
    const events: PipelineEvent[] = [];
    const env: Env = {
      fetch: fetch,
      runBrowserEngine: async (engine, _query, opts) => {
        opts.onBlocked('请在浏览器中完成验证');
        return [hit(engine.id, 'https://example.com/result', 'Result')];
      },
    };
    const result = await runSearch('query', config, env, { onEvent: (event) => events.push(event) });
    expect(result.results).toEqual([]);
    expect(result.sourceStats[0]).toMatchObject({ status: 'blocked' });
    expect(events.map((event) => event.type)).toContain('source_blocked');
    expect(events.findIndex((event) => event.type === 'done')).toBeGreaterThanOrEqual(0);
    await delay(0);
    const doneIndex = events.findIndex((event) => event.type === 'done');
    const lateIndex = events.findIndex((event) => event.type === 'late_results');
    expect(lateIndex).toBeGreaterThan(doneIndex);
    expect(events.some((event) => event.type === 'source_done' && event.source === 'google')).toBe(true);
  });

  it('returns main results before blocked results and merges late hits without rerunning the summary', async () => {
    const config = configFor('google', 'bing');
    config.summary.enabled = true;
    config.summary.contentFetcher = 'none';
    config.llm.apiKey = 'test-key';
    const events: PipelineEvent[] = [];
    let summaryRequests = 0;
    const sharedUrl = 'https://example.com/shared';
    const lateUrl = 'https://example.com/late';
    const env: Env = {
      fetch: async () => {
        summaryRequests += 1;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n'));
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
      runBrowserEngine: async (engine, _query, opts) => {
        if (engine.id === 'bing') {
          opts.onBlocked('CAPTCHA');
          await delay(50);
          return [hit('bing', sharedUrl, 'Shared result'), hit('bing', lateUrl, 'Late result')];
        }
        return [hit('google', sharedUrl, 'Shared result')];
      },
    };
    const result = await runSearch('query', config, env, { onEvent: (event) => events.push(event) });
    expect(result.results.map((item) => item.url)).toEqual([sharedUrl]);
    expect(result.sourceStats.find((stat) => stat.source === 'bing')).toMatchObject({ status: 'blocked' });
    expect(result.summary).toBe('Answer');
    expect(summaryRequests).toBe(1);
    const doneIndex = events.findIndex((event) => event.type === 'done');
    const doneEvent = events[doneIndex];
    expect(doneEvent?.type).toBe('done');
    if (doneEvent?.type === 'done') expect(doneEvent.result.summary).toBe('Answer');
    await delay(75);
    const lateIndex = events.findIndex((event) => event.type === 'late_results');
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(lateIndex).toBeGreaterThan(doneIndex);
    const lateEvent = events[lateIndex];
    expect(lateEvent?.type).toBe('late_results');
    if (lateEvent?.type === 'late_results') {
      expect(lateEvent.results).toHaveLength(2);
      expect(lateEvent.results[0].url).toBe(sharedUrl);
      expect(lateEvent.results[0].sources.map((source) => source.source).sort()).toEqual(['bing', 'google']);
      expect(lateEvent.results[1]).toMatchObject({ url: lateUrl, late: true, score: 0 });
    }
    expect(summaryRequests).toBe(1);
  });

  it('returns empty results when every source is blocked and suppresses late events after abort', async () => {
    const config = configFor('google');
    config.summary.enabled = true;
    const controller = new AbortController();
    const events: PipelineEvent[] = [];
    const env: Env = {
      fetch,
      runBrowserEngine: async (_engine, _query, opts) => {
        opts.onBlocked('CAPTCHA');
        return new Promise<SearchHit[]>((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
    const result = await runSearch('query', config, env, {
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });
    expect(result.results).toEqual([]);
    expect(result.sourceStats[0]).toMatchObject({ status: 'blocked' });
    expect(events.some((event) => event.type === 'done')).toBe(true);
    expect(events.some((event) => event.type === 'summary_start' || event.type === 'summary_prompt')).toBe(false);
    controller.abort();
    await delay(0);
    expect(events.some((event) => event.type === 'late_results')).toBe(false);
    expect(events.filter((event) => event.type === 'source_error')).toHaveLength(0);
  });

  it('emits only source_error when a deferred source fails', async () => {
    const config = configFor('google', 'bing');
    const events: PipelineEvent[] = [];
    const env: Env = {
      fetch,
      runBrowserEngine: async (engine, _query, opts) => {
        if (engine.id === 'bing') {
          opts.onBlocked('CAPTCHA');
          await delay(50);
          throw new Error('verification failed');
        }
        return [hit('google', 'https://example.com/result', 'Result')];
      },
    };
    await runSearch('query', config, env, { onEvent: (event) => events.push(event) });
    await delay(75);
    expect(events.filter((event) => event.type === 'source_error' && event.source === 'bing')).toHaveLength(1);
    expect(events.some((event) => event.type === 'source_done' && event.source === 'bing')).toBe(false);
    expect(events.some((event) => event.type === 'late_results' && event.source === 'bing')).toBe(false);
  });

  it('records a failed source without interrupting successful sources', async () => {
    const config = configFor('google', 'openalex');
    const env: Env = {
      fetch: async () => new Response(JSON.stringify({ results: [{ id: 'https://openalex.org/W1', display_name: 'Recovered result' }] })),
      runBrowserEngine: async () => {
        throw new Error('engine unavailable');
      },
    };
    const events: PipelineEvent[] = [];
    const result = await runSearch('query', config, env, { onEvent: (event) => events.push(event) });
    expect(result.results.map((item) => item.title)).toContain('Recovered result');
    expect(events.some((event) => event.type === 'source_error' && event.source === 'google')).toBe(true);
    expect(events.some((event) => event.type === 'source_done' && event.source === 'openalex')).toBe(true);
  });

  it('emits API summary events in streaming order', async () => {
    const config = configFor('google');
    config.summary.enabled = true;
    config.summary.contentFetcher = 'none';
    config.llm.apiKey = 'test-key';
    const env: Env = {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n'));
              controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      runBrowserEngine: async (engine) => [hit(engine.id, 'https://example.com/result', 'Result')],
    };
    const events: PipelineEvent[] = [];
    const result = await runSearch('query', config, env, { onEvent: (event) => events.push(event) });
    expect(result.summary).toBe('Answer');
    const types = events.map((event) => event.type);
    expect(types.indexOf('summary_start')).toBeLessThan(types.indexOf('summary_delta'));
    expect(types.indexOf('summary_delta')).toBeLessThan(types.indexOf('summary_done'));
    expect(types.indexOf('summary_done')).toBeLessThan(types.indexOf('done'));
  });

  it('sends summary messages to the browser built-in provider without API LLM settings', async () => {
    const config = configFor('google');
    config.summary.enabled = true;
    config.summary.provider = 'chrome-builtin';
    config.summary.contentFetcher = 'none';
    config.llm.apiKey = '';
    config.llm.baseUrl = '';
    config.llm.model = '';
    const env: Env = {
      fetch,
      runBrowserEngine: async (engine) => [hit(engine.id, 'https://example.com/result', 'Result')],
    };
    const events: PipelineEvent[] = [];
    await runSearch('query', config, env, { onEvent: (event) => events.push(event) });
    const prompt = events.find((event) => event.type === 'summary_prompt');
    expect(prompt?.type).toBe('summary_prompt');
    if (prompt?.type === 'summary_prompt') expect(prompt.messages[1].content).toContain('Query: query');
  });
});
