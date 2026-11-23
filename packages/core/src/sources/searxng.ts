import { fetchJson } from '../http';
import type { SearchSource } from '../types';
import { httpOrigin } from '../url';

interface SearxResponse {
  results: { url: string; title: string; content?: string; engine?: string; publishedDate?: string | null }[];
}

/** Self-hosted SearXNG instance with `json` enabled in search.formats. */
export const searxng: SearchSource = {
  id: 'searxng',
  label: 'SearXNG',
  modes: ['web'],
  requiresKey: false,
  requiresBaseUrl: true,
  async search(query, { env, settings, count, signal }) {
    if (!settings.baseUrl) throw new Error('SearXNG base URL not configured');
    const endpoint = new URL(settings.baseUrl);
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/search`;
    endpoint.search = `?q=${encodeURIComponent(query)}&format=json`;
    endpoint.hash = '';
    const origin = httpOrigin(endpoint.href);
    const data = await fetchJson<SearxResponse>(env.fetch, endpoint.href, {
      signal,
      headers: settings.apiKey && origin && origin === settings.apiKeyOrigin
        ? { Authorization: `Bearer ${settings.apiKey}` }
        : undefined,
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
