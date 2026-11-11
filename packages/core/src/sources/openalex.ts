import { fetchJson } from '../http';
import { truncate } from '../text';
import type { Env, SearchHit, SearchSource, SourceSettings } from '../types';

interface OpenAlexWork {
  id: string;
  doi?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  cited_by_count?: number;
  authorships?: { author: { display_name: string } }[];
  primary_location?: { landing_page_url?: string | null; pdf_url?: string | null; source?: { display_name?: string } | null } | null;
  abstract_inverted_index?: Record<string, number[]> | null;
}

export function reconstructAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  return words.filter(Boolean).join(' ');
}

export interface OpenAlexQuery {
  count: number;
  signal?: AbortSignal;
  /** `cited_by_count:desc` turns a relevance search into "the most cited papers on this". */
  sort?: string;
}

/** One OpenAlex works search, shared by the source and by the smart academic search (title checks, most-cited pass). */
export async function searchOpenAlex(env: Env, settings: SourceSettings, query: string, { count, signal, sort }: OpenAlexQuery): Promise<SearchHit[]> {
  const params = new URLSearchParams({
    search: query,
    per_page: String(Math.min(count, 50)),
    select:
      'id,doi,display_name,publication_year,publication_date,cited_by_count,authorships,primary_location,abstract_inverted_index',
  });
  if (sort) params.set('sort', sort);
  if (settings.apiKey) params.set('api_key', settings.apiKey);
  const data = await fetchJson<{ results: OpenAlexWork[] }>(env.fetch, `https://api.openalex.org/works?${params}`, { signal });
  return data.results.map((w, i) => {
    const abstract = reconstructAbstract(w.abstract_inverted_index);
    const authors = (w.authorships ?? []).map((a) => a.author.display_name);
    const venue = w.primary_location?.source?.display_name;
    const byline = [authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''), venue, w.publication_year]
      .filter(Boolean)
      .join(' · ');
    return {
      url: w.doi ?? w.primary_location?.landing_page_url ?? w.id,
      title: w.display_name ?? '(untitled)',
      snippet: truncate([byline, abstract].filter(Boolean).join(' — '), 320),
      content: abstract || undefined,
      publishedAt: w.publication_date ?? undefined,
      meta: {
        authors,
        venue,
        year: w.publication_year ?? undefined,
        citations: w.cited_by_count,
        doi: w.doi?.replace(/^https?:\/\/doi\.org\//, ''),
        pdfUrl: w.primary_location?.pdf_url ?? undefined,
      },
      source: 'openalex' as const,
      rank: i + 1,
    };
  });
}

export const openalex: SearchSource = {
  id: 'openalex',
  label: 'OpenAlex',
  modes: ['academic'],
  requiresKey: false,
  search: (query, { env, settings, count, signal }) => searchOpenAlex(env, settings, query, { count, signal }),
};
