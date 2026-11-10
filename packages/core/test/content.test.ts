import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { fetchContents } from '../src/content';
import { buildSummaryMessages } from '../src/summarize';
import type { Env, FusedResult } from '../src/types';

describe('fetchContents', () => {
  it('skips unresolved Google wrappers and leaves their snippets for the summary', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.summary.contentFetcher = 'direct';
    const wrapper: FusedResult = {
      key: 'google.com/goto?url=opaque',
      url: 'https://www.google.com/goto?url=opaque',
      host: 'example.com',
      title: 'Example page',
      snippet: 'Snippet fallback for the unresolved Google wrapper.',
      sources: [{ source: 'google', rank: 1 }],
      rrfScore: 1,
      score: 1,
      meta: {},
    };
    const requested: string[] = [];
    const env: Env = {
      fetch: async (input) => {
        requested.push(input);
        return new Response('<html><body>Fetched page content with enough words.</body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      },
    };

    const contents = await fetchContents([wrapper], config, env);
    const messages = buildSummaryMessages('example query', [wrapper], contents);

    expect(requested).toEqual([]);
    expect(contents.has(wrapper.key)).toBe(false);
    expect(messages[1].content).toContain(wrapper.snippet);
  });

  it('returns completed content and aborts pending reads at the overall deadline', async () => {
    vi.useFakeTimers();
    try {
      const config = structuredClone(DEFAULT_CONFIG);
      config.summary.contentFetcher = 'direct';
      const result = (url: string, key: string): FusedResult => ({
        key,
        url,
        title: key,
        snippet: '',
        sources: [{ source: 'google', rank: 1 }],
        rrfScore: 1,
        score: 1,
        meta: {},
      });
      const completed = result('https://example.com/complete', 'complete');
      const pending = result('https://example.com/pending', 'pending');
      let pendingSignal: AbortSignal | undefined;
      const env: Env = {
        fetch: async (input, init) => {
          if (input === pending.url) {
            pendingSignal = init?.signal as AbortSignal;
            return new Promise<Response>(() => {});
          }
          return new Response('x'.repeat(140), { headers: { 'content-type': 'text/plain' } });
        },
      };

      const contentsPromise = fetchContents([completed, pending], config, env);
      await vi.advanceTimersByTimeAsync(12000);
      const contents = await contentsPromise;

      expect(contents.get(completed.key)).toBe('x'.repeat(140));
      expect(pendingSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
