import { fetchJson } from '../http';
import { stripTags } from '../text';
import type { SearchSource } from '../types';

interface BraveResponse {
  web?: { results?: { title: string; url: string; description?: string; page_age?: string; extra_snippets?: string[] }[] };
}

export const brave: SearchSource = {
  id: 'brave',
  label: 'Brave',
  kind: 'web',
  requiresKey: true,
  async search(query, { env, settings, count, signal }) {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}&extra_snippets=true`;
    const data = await fetchJson<BraveResponse>(env.fetch, url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': settings.apiKey ?? '' },
      signal,
    });
    return (data.web?.results ?? []).slice(0, count).map((r, i) => ({
      url: r.url,
      title: stripTags(r.title),
      snippet: stripTags(r.description ?? ''),
      content: r.extra_snippets?.length ? r.extra_snippets.map(stripTags).join('\n') : undefined,
      publishedAt: r.page_age,
      source: 'brave' as const,
      rank: i + 1,
    }));
  },
};
