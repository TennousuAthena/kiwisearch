import { fetchJson } from '../http';
import { stripTags, truncate } from '../text';
import type { SearchHit, SearchSource } from '../types';

interface CrossrefWork {
  DOI: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { 'date-parts'?: (number | null)[][] };
  'container-title'?: string[];
  'is-referenced-by-count'?: number;
  abstract?: string;
}

function authorName(author: NonNullable<CrossrefWork['author']>[number]): string {
  return author.name ?? [author.given, author.family].filter(Boolean).join(' ');
}

/** https://api.crossref.org/swagger-ui/index.html */
export const crossref: SearchSource = {
  id: 'crossref',
  label: 'Crossref',
  modes: ['academic'],
  requiresKey: false,
  async search(query, { env, count, signal }) {
    const params = new URLSearchParams({
      query,
      rows: String(Math.min(count, 30)),
      select: 'DOI,title,author,issued,container-title,is-referenced-by-count,abstract',
    });
    const data = await fetchJson<{ message?: { items?: CrossrefWork[] } }>(env.fetch, `https://api.crossref.org/works?${params}`, { signal });
    const hits: SearchHit[] = [];
    for (const work of data.message?.items ?? []) {
      const title = stripTags(work.title?.[0] ?? '');
      if (!work.DOI || !title) continue;
      const authors = (work.author ?? []).map(authorName).filter(Boolean);
      const venue = stripTags(work['container-title']?.[0] ?? '') || undefined;
      const year = work.issued?.['date-parts']?.[0]?.[0] ?? undefined;
      const abstract = stripTags(work.abstract ?? '').replace(/^Abstract\s*/i, '');
      const byline = [authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''), venue, year].filter(Boolean).join(' · ');
      hits.push({
        url: `https://doi.org/${work.DOI}`,
        title,
        snippet: truncate([byline, abstract].filter(Boolean).join(' — '), 320),
        content: abstract || undefined,
        meta: { authors, venue, year, citations: work['is-referenced-by-count'], doi: work.DOI.toLowerCase() },
        source: 'crossref',
        rank: hits.length + 1,
      });
    }
    return hits.slice(0, count);
  },
};
