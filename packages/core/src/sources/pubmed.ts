import { parse } from 'node-html-parser';
import { fetchJson, fetchText } from '../http';
import { truncate } from '../text';
import type { SearchHit, SearchSource } from '../types';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

type ParsedRecord = { pmid: string; hit: Omit<SearchHit, 'source' | 'rank'> };

function clean(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** PubMed titles end in a full stop, and translated ones are wrapped in brackets: `[Title in English].` */
function cleanTitle(raw: string): string {
  return clean(raw).replace(/\.$/, '').replace(/^\[(.+)\]$/, '$1');
}

/** Structured abstracts come in labelled parts (BACKGROUND, METHODS, ...); keep the labels so the text still reads as sections. */
function abstractOf(article: ReturnType<typeof parse>): string {
  return article
    .querySelectorAll('abstract > abstracttext')
    .map((part) => {
      const label = clean(part.getAttribute('label'));
      const text = clean(part.text);
      return label && text ? `${label[0]}${label.slice(1).toLowerCase()}: ${text}` : text;
    })
    .filter(Boolean)
    .join(' ');
}

/**
 * `efetch` XML (`retmode=xml&rettype=abstract`): the only PubMed format that carries abstracts.
 * Tag names are matched in lower case, which is how the parser compares them. The reference list is not read:
 * it holds hundreds of other papers' IDs, so the article's own DOI comes from its `ELocationID` or the direct `ArticleIdList`.
 */
export function parsePubmedXml(xml: string): ParsedRecord[] {
  const records: ParsedRecord[] = [];
  for (const article of parse(xml).querySelectorAll('pubmedarticle')) {
    const pmid = clean(article.querySelector('medlinecitation > pmid')?.text);
    const title = cleanTitle(article.querySelector('articletitle')?.text ?? '');
    if (!pmid || !title) continue;
    const authors = article
      .querySelectorAll('authorlist > author')
      .map((author) => {
        const collective = clean(author.querySelector('collectivename')?.text);
        if (collective) return collective;
        const family = clean(author.querySelector('lastname')?.text);
        const given = clean(author.querySelector('forename')?.text) || clean(author.querySelector('initials')?.text);
        return [given, family].filter(Boolean).join(' ');
      })
      .filter(Boolean);
    const venue = clean(article.querySelector('journal > title')?.text) || undefined;
    const pubDate = article.querySelector('journal journalissue pubdate');
    // Some issues are dated by season or range (`<MedlineDate>2019 Jan-Feb</MedlineDate>`) instead of `<Year>`.
    const year =
      Number(clean(pubDate?.querySelector('year')?.text) || clean(pubDate?.querySelector('medlinedate')?.text).match(/\d{4}/)?.[0]) ||
      Number(clean(article.querySelector('articledate year')?.text)) ||
      undefined;
    const doi = (
      clean(article.querySelector('elocationid[eidtype="doi"]')?.text) ||
      clean(article.querySelector('pubmeddata > articleidlist > articleid[idtype="doi"]')?.text)
    ).toLowerCase();
    const epub = article.querySelector('articledate[datetype="Electronic"]') ?? article.querySelector('articledate');
    const published = epub
      ? [clean(epub.querySelector('year')?.text), clean(epub.querySelector('month')?.text).padStart(2, '0'), clean(epub.querySelector('day')?.text).padStart(2, '0')].join('-')
      : '';
    const abstract = abstractOf(article);
    const byline = [authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''), venue, year].filter(Boolean).join(' · ');
    records.push({
      pmid,
      hit: {
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        title,
        snippet: truncate([byline, abstract].filter(Boolean).join(' — '), 320),
        content: abstract || undefined,
        publishedAt: /^\d{4}-\d{2}-\d{2}$/.test(published) ? published : undefined,
        meta: { authors, venue, year, doi: doi || undefined },
      },
    });
  }
  return records;
}

/**
 * NCBI E-utilities: `esearch` finds the PMIDs, `efetch` returns their records with abstracts. Works without a key
 * (3 requests a second per IP, and a search makes two); a key the user got from NCBI raises that to 10.
 * https://www.ncbi.nlm.nih.gov/books/NBK25497/
 */
export const pubmed: SearchSource = {
  id: 'pubmed',
  label: 'PubMed',
  modes: ['academic'],
  requiresKey: false,
  async search(query, { env, settings, count, signal, language }) {
    // PubMed's index is English; a query without Latin letters can't match, so don't spend one of the 3 requests a second on it.
    if (!/[A-Za-z]/.test(query)) return [];
    const identify = (params: Record<string, string>) => {
      const search = new URLSearchParams({ ...params, tool: 'kiwi-search' });
      if (settings.apiKey) search.set('api_key', settings.apiKey);
      return search.toString();
    };
    const found = await fetchJson<{ esearchresult?: { idlist?: string[] }; error?: string }>(
      env.fetch,
      `${EUTILS}/esearch.fcgi?${identify({ db: 'pubmed', retmode: 'json', sort: 'relevance', retmax: String(Math.min(count, 30)), term: language === 'en' ? `(${query}) AND english[la]` : query })}`,
      { signal },
    );
    // Over the rate limit NCBI answers 200 with `{"error": "API rate limit exceeded", ...}`.
    if (found.error) throw new Error(`PubMed: ${found.error}`);
    const ids = found.esearchresult?.idlist ?? [];
    if (!ids.length) return [];
    const xml = await fetchText(
      env.fetch,
      `${EUTILS}/efetch.fcgi?${identify({ db: 'pubmed', retmode: 'xml', rettype: 'abstract', id: ids.join(',') })}`,
      { signal },
    );
    const byPmid = new Map(parsePubmedXml(xml).map(({ pmid, hit }) => [pmid, hit]));
    // efetch is not guaranteed to keep the order of the ids; the relevance order is esearch's.
    return ids
      .flatMap((id) => byPmid.get(id) ?? [])
      .slice(0, count)
      .map((hit, index): SearchHit => ({ ...hit, source: 'pubmed', rank: index + 1 }));
  },
};
