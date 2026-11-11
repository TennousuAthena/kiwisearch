import { HttpError } from '../http';
import { decodeEntities } from '../text';
import type { SearchHit, SearchSource } from '../types';

/** The JSON writes a list as an array, but a list of one as the bare value. */
type OneOrMany<T> = T | T[];

interface DblpInfo {
  authors?: { author?: OneOrMany<{ text?: string }> };
  title?: string;
  venue?: OneOrMany<string>;
  year?: string;
  type?: string;
  doi?: string;
  /** Electronic edition: the DOI link, the publisher page or the arXiv abstract. */
  ee?: OneOrMany<string>;
  /** DBLP's own record page. */
  url?: string;
}

interface DblpResponse {
  result?: { hits?: { hit?: OneOrMany<{ info?: DblpInfo }> } };
}

const many = <T>(value: OneOrMany<T> | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** DBLP tells namesakes apart with a number (`Wei Wang 0001`); it is not part of the name. */
const personName = (text: string) => decodeEntities(text).replace(/\s+\d{4}$/, '').trim();

export function parseDblp(data: DblpResponse): Omit<SearchHit, 'source' | 'rank'>[] {
  const hits: Omit<SearchHit, 'source' | 'rank'>[] = [];
  for (const { info } of many(data.result?.hits?.hit)) {
    if (!info) continue;
    const title = decodeEntities(info.title ?? '').replace(/\.$/, '').trim();
    const url = [...many(info.ee), info.url].find((link) => link && /^https?:\/\//i.test(link));
    if (!title || !url) continue;
    const authors = many(info.authors?.author)
      .map((author) => personName(author.text ?? ''))
      .filter(Boolean);
    const venue = many(info.venue).join(', ') || undefined;
    const year = Number(info.year) || undefined;
    hits.push({
      url,
      title,
      // DBLP indexes bibliographic records only, so there is no abstract: the snippet is the byline.
      snippet: [authors.slice(0, 4).join(', ') + (authors.length > 4 ? ' et al.' : ''), venue, year].filter(Boolean).join(' · '),
      meta: { authors, venue, year, doi: info.doi?.toLowerCase() },
    });
  }
  return hits;
}

/**
 * https://dblp.org/faq/How+to+use+the+dblp+search+API.html (computer-science bibliography, no key).
 * DBLP runs a proof-of-work bot check in front of the API (Anubis): a client it doesn't trust gets an HTML page with
 * status 202 instead of JSON. That has to read as an error here, not as "no results".
 */
export const dblp: SearchSource = {
  id: 'dblp',
  label: 'DBLP',
  modes: ['academic'],
  requiresKey: false,
  async search(query, { env, count, signal }) {
    // A computer-science index in English and Latin script; skip queries it cannot match.
    if (!/[A-Za-z]/.test(query)) return [];
    const params = new URLSearchParams({ q: query, format: 'json', h: String(Math.min(count, 30)) });
    const res = await env.fetch(`https://dblp.org/search/publ/api?${params}`, { signal });
    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
    const text = await res.text();
    let data: DblpResponse;
    try {
      data = JSON.parse(text) as DblpResponse;
    } catch {
      throw new Error(/not a bot|anubis/i.test(text) ? 'DBLP is asking for a bot check instead of answering' : 'DBLP did not answer with JSON');
    }
    return parseDblp(data)
      .slice(0, count)
      .map((hit, index): SearchHit => ({ ...hit, source: 'dblp', rank: index + 1 }));
  },
};
