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

describe('runSearch', () => {
  it('extends blocked source timeout path and continues after a CAPTCHA is solved', async () => {
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
    expect(result.results[0].title).toBe('Result');
    expect(events.map((event) => event.type)).toContain('source_blocked');
    expect(events.map((event) => event.type)).toContain('source_done');
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

  it('sends summary messages to the browser built-in provider without an API key', async () => {
    const config = configFor('google');
    config.summary.enabled = true;
    config.summary.provider = 'chrome-builtin';
    config.summary.contentFetcher = 'none';
    config.llm.apiKey = '';
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
