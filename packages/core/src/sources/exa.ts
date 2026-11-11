import { fetchJson } from '../http';
import { truncate } from '../text';
import type { SearchSource } from '../types';

interface ExaResponse {
  results: { title?: string; url: string; publishedDate?: string; author?: string; text?: string; summary?: string; highlights?: string[] }[];
}

export const exa: SearchSource = {
  id: 'exa',
  label: 'Exa',
  modes: ['web'],
  requiresKey: true,
  async search(query, { env, settings, count, signal }) {
    const data = await fetchJson<ExaResponse>(env.fetch, 'https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey ?? '' },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults: Math.min(count, 25),
        contents: { text: { maxCharacters: 4000 }, highlights: { numSentences: 3, highlightsPerUrl: 1 } },
      }),
      signal,
    });
    return data.results.map((r, i) => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: truncate((r.highlights?.[0] ?? r.text ?? '').replace(/\s+/g, ' ').trim(), 300),
      content: r.text,
      publishedAt: r.publishedDate,
      meta: r.author ? { authors: [r.author] } : undefined,
      source: 'exa' as const,
      rank: i + 1,
    }));
  },
};
