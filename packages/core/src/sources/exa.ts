import { fetchJson } from '../http';
import { markdownSnippet } from '../text';
import { newsCutoff, normalizeNewsOptions, parseNewsTime } from '../news';
import { absoluteHttpUrl } from '../engines/shared';
import type { SearchSource } from '../types';

interface ExaResponse {
  results: { title?: string; url: string; publishedDate?: string; author?: string; image?: string; text?: string; summary?: string; highlights?: string[] }[];
}

/**
 * Exa hands back a page as Markdown, in `text` and in `highlights`, and the start of a page is often a table: Wikipedia opens with its
 * infobox, an annual report with pages of them. A highlight is a passage of up to `maxCharacters`, not a sentence, so a highlight cut
 * short lands inside that table (checked: at 600 characters the Wikipedia highlight began with `| --- | --- |`). No setting avoids it, so
 * the snippet is made from the Markdown by `markdownSnippet`, which skips tables and reads the first paragraph of prose, from the
 * highlight first and from `text` when the highlight has none. `content` stays Markdown: the overview and the decision model read it
 * as it is. (`numSentences` is deprecated and `highlightsPerUrl` is ignored; each answer said so in `warnings`.)
 */
export const exa: SearchSource = {
  id: 'exa',
  label: 'Exa',
  modes: ['web', 'news'],
  requiresKey: true,
  async search(query, { env, settings, count, signal, mode, news }) {
    const newsMode = mode === 'news';
    const cutoff = newsCutoff(normalizeNewsOptions(news).range, new Date());
    const data = await fetchJson<ExaResponse>(env.fetch, 'https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey ?? '' },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults: Math.min(count, 25),
        ...(newsMode ? { category: 'news', ...(cutoff !== undefined ? { startPublishedDate: new Date(cutoff).toISOString() } : {}) } : {}),
        contents: { text: { maxCharacters: 4000 }, highlights: { maxCharacters: 1500 } },
      }),
      signal,
    });
    const retrievedAt = new Date();
    return data.results.map((r, i) => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: markdownSnippet([r.highlights?.[0], r.text], { title: r.title, max: 300 }),
      content: r.text,
      ...(newsMode ? {
        ...parseNewsTime(r.publishedDate, retrievedAt),
        news: {
          ...parseNewsTime(r.publishedDate, retrievedAt).news,
          byline: r.author,
          thumbnail: absoluteHttpUrl(r.image, r.url) ?? undefined,
        },
        meta: r.author ? { author: r.author } : undefined,
      } : { publishedAt: r.publishedDate, meta: r.author ? { authors: [r.author] } : undefined }),
      source: 'exa' as const,
      rank: i + 1,
    }));
  },
};
