import { describe, expect, it } from 'vitest';
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
});
