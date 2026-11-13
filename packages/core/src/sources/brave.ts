import { fetchJson } from '../http';
import { stripTags } from '../text';
import { normalizeNewsOptions, parseNewsTime } from '../news';
import { absoluteHttpUrl } from '../engines/shared';
import type { SearchSource } from '../types';

interface BraveResponse {
  web?: { results?: { title: string; url: string; description?: string; page_age?: string; extra_snippets?: string[] }[] };
  results?: {
    title: string; url: string; description?: string; page_age?: string; age?: string; extra_snippets?: string[];
    profile?: { name?: string }; thumbnail?: { src?: string; original?: string };
  }[];
}

export const brave: SearchSource = {
  id: 'brave',
  label: 'Brave',
  modes: ['web', 'news'],
  requiresKey: true,
  async search(query, { env, settings, count, signal, mode, news }) {
    const options = normalizeNewsOptions(news);
    const freshness = { any: '', day: 'pd', week: 'pw', month: 'pm' }[options.range];
    const newsMode = mode === 'news';
    const url = `https://api.search.brave.com/res/v1/${newsMode ? 'news' : 'web'}/search?q=${encodeURIComponent(query)}&count=${Math.min(count, newsMode ? 50 : 20)}&extra_snippets=true${newsMode && freshness ? `&freshness=${freshness}` : ''}`;
    const data = await fetchJson<BraveResponse>(env.fetch, url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': settings.apiKey ?? '' },
      signal,
    });
    const retrievedAt = new Date();
    if (newsMode) return (data.results ?? []).slice(0, count).map((r, i) => ({
      url: r.url,
      title: stripTags(r.title),
      snippet: stripTags(r.description ?? ''),
      content: r.extra_snippets?.length ? r.extra_snippets.map(stripTags).join('\n') : undefined,
      // Brave documents page_age as either published or modified; neither page_age nor page_fetched proves publication.
      news: {
        ...parseNewsTime(r.age ?? r.page_age, retrievedAt, 'unknown').news,
        publisher: r.profile?.name ? stripTags(r.profile.name) : undefined,
        thumbnail: absoluteHttpUrl(r.thumbnail?.src ?? r.thumbnail?.original, r.url) ?? undefined,
      },
      source: 'brave' as const,
      rank: i + 1,
    }));
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
