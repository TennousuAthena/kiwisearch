import { fetchJson } from '../http';
import type { SearchSource } from '../types';

interface DeepSeekSearchResponse {
  results: {
    rerank_score?: number;
    title: string;
    url: string;
    snippet?: string;
    summary?: string;
    content?: string;
    site_name?: string | null;
    date?: string | null;
  }[];
}

/** https://api-docs.deepseek.com/guides/search.md */
export const deepseek: SearchSource = {
  id: 'deepseek',
  label: 'DeepSeek',
  modes: ['web'],
  requiresKey: true,
  async search(query, { env, settings, count, signal }) {
    const data = await fetchJson<DeepSeekSearchResponse>(env.fetch, 'https://api.deepseek.com/v1/tools/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey ?? ''}` },
      body: JSON.stringify({ query: query.slice(0, 128), count: Math.min(count, 50) }),
      signal,
    });
    return data.results.map((r, i) => ({
      url: r.url,
      title: r.title,
      snippet: r.snippet ?? '',
      content: r.content || r.summary || undefined,
      publishedAt: r.date ?? undefined,
      meta: { siteName: r.site_name ?? undefined, sourceScore: r.rerank_score },
      source: 'deepseek' as const,
      rank: i + 1,
    }));
  },
};
