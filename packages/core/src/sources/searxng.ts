import { fetchJson } from '../http';
import type { SearchSource } from '../types';

interface SearxResponse {
  results: { url: string; title: string; content?: string; engine?: string; publishedDate?: string | null }[];
}

/** Self-hosted SearXNG instance with `json` enabled in search.formats. */
export const searxng: SearchSource = {
  id: 'searxng',
  label: 'SearXNG',
  kind: 'web',
  requiresKey: false,
  async search(query, { env, settings, count, signal }) {
    if (!settings.baseUrl) throw new Error('SearXNG base URL not configured');
    const base = settings.baseUrl.replace(/\/+$/, '');
    const data = await fetchJson<SearxResponse>(env.fetch, `${base}/search?q=${encodeURIComponent(query)}&format=json`, {
      signal,
      headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : undefined,
    });
    return data.results.slice(0, count).map((r, i) => ({
      url: r.url,
      title: r.title,
      snippet: r.content ?? '',
      publishedAt: r.publishedDate ?? undefined,
      source: 'searxng' as const,
      rank: i + 1,
    }));
  },
};
