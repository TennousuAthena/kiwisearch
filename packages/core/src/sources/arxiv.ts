import { parse } from 'node-html-parser';
import { fetchText } from '../http';
import { truncate } from '../text';
import type { SearchHit, SearchSource } from '../types';

function clean(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** Atom feed from export.arxiv.org/api/query. */
export function parseArxivFeed(xml: string): Omit<SearchHit, 'source' | 'rank'>[] {
  const hits: Omit<SearchHit, 'source' | 'rank'>[] = [];
  for (const entry of parse(xml).querySelectorAll('entry')) {
    const raw = entry.toString();
    const link = entry.querySelector('link[rel="alternate"]')?.getAttribute('href') ?? entry.querySelector('id')?.text;
    const title = clean(entry.querySelector('title')?.text);
    if (!link || !title) continue;
    const url = link.trim().replace(/^http:/, 'https:').replace(/v\d+$/, '');
    const abstract = clean(entry.querySelector('summary')?.text);
    const authors = entry.querySelectorAll('author name').map((name) => clean(name.text)).filter(Boolean);
    const published = entry.querySelector('published')?.text.trim() ?? '';
    const year = Number(published.slice(0, 4)) || undefined;
    const doi = clean(raw.match(/<arxiv:doi[^>]*>([^<]*)</)?.[1]);
    const journalRef = clean(raw.match(/<arxiv:journal_ref[^>]*>([^<]*)</)?.[1]);
    const byline = [authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''), year].filter(Boolean).join(' · ');
    hits.push({
      url,
      title,
      snippet: truncate([byline, abstract].filter(Boolean).join(' — '), 320),
      content: abstract || undefined,
      publishedAt: published || undefined,
      meta: {
        authors,
        venue: journalRef || 'arXiv',
        year,
        doi: doi || undefined,
        pdfUrl: entry.querySelector('link[title="pdf"]')?.getAttribute('href')?.replace(/^http:/, 'https:'),
      },
    });
  }
  return hits;
}

/** Plain `all:` terms; arXiv's AND form returns nothing for natural-language queries. */
function searchQuery(query: string): string {
  const words = query
    .split(/\s+/)
    .map((word) => word.replace(/["():]/g, ''))
    .filter(Boolean)
    .slice(0, 12);
  return `all:${words.map(encodeURIComponent).join('+')}`;
}

/** https://info.arxiv.org/help/api/user-manual.html */
export const arxiv: SearchSource = {
  id: 'arxiv',
  label: 'arXiv',
  modes: ['academic'],
  requiresKey: false,
  async search(query, { env, count, signal }) {
    // arXiv's index is English-centric; a query without Latin letters can't match.
    if (!/[A-Za-z]/.test(query)) return [];
    const url = `https://export.arxiv.org/api/query?search_query=${searchQuery(query)}&start=0&max_results=${Math.min(count, 30)}&sortBy=relevance`;
    const xml = await fetchText(env.fetch, url, { signal });
    return parseArxivFeed(xml)
      .slice(0, count)
      .map((hit, index): SearchHit => ({ ...hit, source: 'arxiv', rank: index + 1 }));
  },
};
