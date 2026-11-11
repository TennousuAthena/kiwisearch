import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { createSourceCache } from '../src/cache';
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

  it('tells a login wall from a captcha when the engine says which', async () => {
    const events: PipelineEvent[] = [];
    const env: Env = {
      fetch: fetch,
      runBrowserEngine: async (_engine, _query, opts) => {
        opts.onBlocked('需要登录', 'login');
        return [];
      },
    };
    const result = await runSearch('query', configFor('google'), env, { onEvent: (event) => events.push(event) });
    expect(events.find((event) => event.type === 'source_blocked')).toMatchObject({ source: 'google', reason: 'login' });
    expect(result.sourceStats[0]).toMatchObject({ status: 'blocked', blockedReason: 'login' });
  });

  it('treats a block with no stated reason as a captcha', async () => {
    const events: PipelineEvent[] = [];
    const env: Env = {
      fetch: fetch,
      runBrowserEngine: async (_engine, _query, opts) => {
        opts.onBlocked('请验证');
        return [];
      },
    };
    const result = await runSearch('query', configFor('google'), env, { onEvent: (event) => events.push(event) });
    expect(events.find((event) => event.type === 'source_blocked')).toMatchObject({ reason: 'captcha' });
    expect(result.sourceStats[0]).toMatchObject({ blockedReason: 'captcha' });
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
    const config = configFor('google', 'brave');
    config.sources.brave!.apiKey = '{{SECRET_brave01}}';
    const env: Env = {
      fetch: async () =>
        new Response(JSON.stringify({ web: { results: [{ title: 'Recovered result', url: 'https://example.com/recovered' }] } })),
      runBrowserEngine: async () => {
        throw new Error('engine unavailable');
      },
    };
    const events: PipelineEvent[] = [];
    const result = await runSearch('query', config, env, { onEvent: (event) => events.push(event) });
    expect(result.results.map((item) => item.title)).toContain('Recovered result');
    expect(events.some((event) => event.type === 'source_error' && event.source === 'google')).toBe(true);
    expect(events.some((event) => event.type === 'source_done' && event.source === 'brave')).toBe(true);
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

  it('summarizes through a local server such as Ollama without an API key', async () => {
    const config = configFor('google');
    config.summary.enabled = true;
    config.summary.contentFetcher = 'none';
    config.llm = { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:14b' };
    const urls: string[] = [];
    const env: Env = {
      fetch: async (input) => {
        urls.push(input);
        return new Response('data: {"choices":[{"delta":{"content":"Local answer"}}]}\n\ndata: [DONE]\n\n');
      },
      runBrowserEngine: async (engine) => [hit(engine.id, 'https://example.com/result', 'Result')],
    };
    const result = await runSearch('query', config, env);
    expect(result.summary).toBe('Local answer');
    expect(urls).toEqual(['http://localhost:11434/v1/chat/completions']);
  });

  it('skips the summary for a remote endpoint that has no key', async () => {
    const config = configFor('google');
    config.summary.enabled = true;
    config.llm = { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-flash' };
    const events: PipelineEvent[] = [];
    const env: Env = {
      fetch: async () => {
        throw new Error('must not be called');
      },
      runBrowserEngine: async (engine) => [hit(engine.id, 'https://example.com/result', 'Result')],
    };
    await runSearch('query', config, env, { onEvent: (event) => events.push(event) });
    expect(events.some((event) => event.type.startsWith('summary'))).toBe(false);
  });

  it('starts the source timeout when the engine begins work, not when it is queued', async () => {
    const config = configFor('google');
    config.sourceTimeoutMs = 60;
    const env: Env = {
      fetch,
      runBrowserEngine: async (engine, _query, opts) => {
        await delay(150);
        opts.onStart();
        await delay(20);
        return [hit(engine.id, 'https://example.com/result', 'Result')];
      },
    };
    const result = await runSearch('query', config, env);
    expect(result.results).toHaveLength(1);
    expect(result.sourceStats[0].error).toBeUndefined();
  });

  it('still times out a source that hangs after it started', async () => {
    const config = configFor('google');
    config.sourceTimeoutMs = 40;
    const env: Env = {
      fetch,
      runBrowserEngine: (_engine, _query, opts) =>
        new Promise<SearchHit[]>((_resolve, reject) => {
          opts.onStart();
          opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
        }),
    };
    const result = await runSearch('query', config, env);
    expect(result.sourceStats[0].error).toBe('timeout after 40ms');
  });

  it('only queries sources that serve the requested mode', async () => {
    const config = configFor('google', 'scholar');
    const asked: string[] = [];
    const env: Env = {
      fetch,
      runBrowserEngine: async (engine, _query, opts) => {
        asked.push(`${engine.id}:${opts.mode}`);
        return [hit(engine.id, `https://example.com/${engine.id}`, engine.id)];
      },
    };
    const academic = await runSearch('query', config, env, { mode: 'academic' });
    expect(asked).toEqual(['scholar:academic']);
    expect(academic.mode).toBe('academic');
    await runSearch('query', config, env);
    expect(asked).toEqual(['scholar:academic', 'google:web']);
    await expect(runSearch('query', config, env, { mode: 'images' })).rejects.toThrow(/images/);
  });

  it('emits partial fused results as sources arrive and a final one at the end', async () => {
    const config = configFor('google', 'bing');
    const events: PipelineEvent[] = [];
    const env: Env = {
      fetch,
      runBrowserEngine: async (engine) => {
        if (engine.id === 'bing') await delay(40);
        return [hit(engine.id, `https://example.com/${engine.id}`, engine.id)];
      },
    };
    await runSearch('query', config, env, { onEvent: (event) => events.push(event) });
    const fused = events.filter((event) => event.type === 'fused');
    expect(fused.map((event) => event.type === 'fused' && !!event.partial)).toEqual([true, false]);
    expect(fused[0].type === 'fused' && fused[0].results).toHaveLength(1);
    expect(fused[1].type === 'fused' && fused[1].results).toHaveLength(2);
  });

  it('lets slow sources merge in late after the soft deadline', async () => {
    const config = configFor('google', 'bing');
    const events: PipelineEvent[] = [];
    const env: Env = {
      fetch,
      runBrowserEngine: async (engine) => {
        if (engine.id === 'bing') await delay(120);
        return [hit(engine.id, `https://example.com/${engine.id}`, engine.id)];
      },
    };
    const result = await runSearch('query', config, env, { softDeadlineMs: 30, onEvent: (event) => events.push(event) });
    expect(result.results.map((item) => item.url)).toEqual(['https://example.com/google']);
    expect(result.sourceStats.find((stat) => stat.source === 'bing')).toMatchObject({ status: 'late' });
    await delay(150);
    const late = events.find((event) => event.type === 'late_results');
    expect(late?.type === 'late_results' && late.results.map((item) => item.url)).toEqual([
      'https://example.com/google',
      'https://example.com/bing',
    ]);
    expect(events.findIndex((event) => event.type === 'late_results')).toBeGreaterThan(events.findIndex((event) => event.type === 'done'));
  });

  it('keeps waiting past the soft deadline while there is nothing to show', async () => {
    const config = configFor('google');
    const env: Env = {
      fetch,
      runBrowserEngine: async (engine) => {
        await delay(80);
        return [hit(engine.id, 'https://example.com/slow', 'Slow')];
      },
    };
    const result = await runSearch('query', config, env, { softDeadlineMs: 20 });
    expect(result.results).toHaveLength(1);
  });

  describe('the overview and the soft deadline', () => {
    const streamed = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n'));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    const summaryConfig = (...enabled: SourceId[]) => {
      const config = configFor(...enabled);
      config.summary.enabled = true;
      config.summary.contentFetcher = 'none';
      config.llm.apiKey = 'test-key';
      return config;
    };
    /** `google` answers at once but with titles only (like DuckDuckGo); `bing` answers after `bingMs` with text. */
    const envWith = (bingMs: number): Env => ({
      fetch: async () => streamed(),
      runBrowserEngine: async (engine) => {
        if (engine.id === 'bing') {
          await delay(bingMs);
          return [hit('bing', 'https://example.com/bing', 'Bing')];
        }
        return [{ source: 'google', url: 'https://example.com/google', title: 'Google', snippet: '', rank: 1 }];
      },
    });

    it('waits past the deadline for a source with text when the quick ones had none, so the overview is not lost', async () => {
      const events: PipelineEvent[] = [];
      const result = await runSearch('query', summaryConfig('google', 'bing'), envWith(100), { softDeadlineMs: 30, onEvent: (event) => events.push(event) });
      const types = events.map((event) => event.type);
      expect(types).toContain('summary_start');
      expect(types.indexOf('summary_done')).toBeLessThan(types.indexOf('done'));
      expect(result.summary).toBe('Answer');
      expect(result.citations.map((citation) => citation.url)).toEqual(['https://example.com/bing']);
      // The titles-only source still showed up as soon as it was there.
      expect(events.find((event) => event.type === 'fused')).toMatchObject({ partial: true });
    });

    it('does not hold the results back when a quick source already has text, or when no overview is wanted', async () => {
      const quick: Env = { fetch: async () => streamed(), runBrowserEngine: async (engine) => (engine.id === 'bing' ? (await delay(300), [hit('bing', 'https://example.com/bing', 'Bing')]) : [hit('google', 'https://example.com/google', 'Google')]) };
      const started = Date.now();
      const withText = await runSearch('query', summaryConfig('google', 'bing'), quick, { softDeadlineMs: 30 });
      expect(Date.now() - started).toBeLessThan(250);
      expect(withText.sourceStats.find((stat) => stat.source === 'bing')).toMatchObject({ status: 'late' });
      expect(withText.summary).toBe('Answer');

      const off = summaryConfig('google', 'bing');
      off.summary.enabled = false;
      const started2 = Date.now();
      const events: PipelineEvent[] = [];
      await runSearch('query', off, envWith(300), { softDeadlineMs: 30, onEvent: (event) => events.push(event) });
      expect(Date.now() - started2).toBeLessThan(250);
      expect(events.some((event) => event.type.startsWith('summary'))).toBe(false);
    });

    it('stops waiting when every source has answered, even if none had text', async () => {
      const bare: Env = { fetch: async () => streamed(), runBrowserEngine: async (engine) => [{ source: engine.id, url: `https://example.com/${engine.id}`, title: engine.id, snippet: '', rank: 1 }] };
      const events: PipelineEvent[] = [];
      const result = await runSearch('query', summaryConfig('google', 'bing'), bare, { softDeadlineMs: 30, onEvent: (event) => events.push(event) });
      expect(result.results).toHaveLength(2);
      expect(events.some((event) => event.type.startsWith('summary'))).toBe(false);
    });
  });

  it('serves repeat searches from the source cache', async () => {
    const config = configFor('google');
    let calls = 0;
    const env: Env = {
      fetch,
      cache: createSourceCache(),
      runBrowserEngine: async (engine) => {
        calls += 1;
        return [hit(engine.id, 'https://example.com/result', 'Result')];
      },
    };
    await runSearch('Query', config, env);
    const events: PipelineEvent[] = [];
    const again = await runSearch('query', config, env, { onEvent: (event) => events.push(event) });
    expect(calls).toBe(1);
    expect(again.results).toHaveLength(1);
    expect(events.some((event) => event.type === 'source_done' && event.source === 'google')).toBe(true);
  });
});
