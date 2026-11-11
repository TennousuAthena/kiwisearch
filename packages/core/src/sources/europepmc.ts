import { fetchJson } from '../http';
import { decodeEntities, truncate } from '../text';
import type { SearchHit, SearchSource } from '../types';

interface EuropePmcRecord {
  /** `MED` (PubMed), `PMC`, `PPR` (preprint), `PAT` (patent), `AGR`, `CBA`, ... */
  source: string;
  id: string;
  pmid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  authorList?: { author?: { fullName?: string; firstName?: string; lastName?: string; collectiveName?: string }[] };
  journalInfo?: { yearOfPublication?: number; journal?: { title?: string } } | null;
  /** Preprints and reports: the server or publisher stands where a journal would. */
  bookOrReportDetails?: { publisher?: string } | null;
  pubYear?: string;
  firstPublicationDate?: string;
  citedByCount?: number;
  abstractText?: string;
  fullTextUrlList?: { fullTextUrl?: { availabilityCode?: string; documentStyle?: string; url?: string }[] };
}

/** Abstracts arrive with their markup (`<h4>ABSTRACT</h4>`, `<title>Abstract</title><p>…</p>`, `<sup>`); keep the words. */
function abstractText(raw: string | undefined): string {
  return decodeEntities((raw ?? '').replace(/<\/(?:p|h\d|title|li|div|sec)>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .replace(/^abstract\b[:.]?\s*/i, '')
    .trim();
}

function authorsOf(record: EuropePmcRecord): string[] {
  const listed = (record.authorList?.author ?? [])
    .map((a) => a.collectiveName ?? ([a.firstName, a.lastName].filter(Boolean).join(' ') || a.fullName || ''))
    .filter(Boolean);
  if (listed.length) return listed;
  return (record.authorString ?? '').replace(/\.$/, '').split(/,\s*/).filter(Boolean);
}

/** A PubMed record is linked to PubMed itself, which is also what the PubMed source returns, so the two merge by URL. */
function pageUrl(record: EuropePmcRecord): string {
  if (record.source === 'MED' && record.pmid) return `https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/`;
  return `https://europepmc.org/article/${record.source}/${record.id}`;
}

export function parseEuropePmc(data: { resultList?: { result?: EuropePmcRecord[] } }): Omit<SearchHit, 'source' | 'rank'>[] {
  const hits: Omit<SearchHit, 'source' | 'rank'>[] = [];
  for (const record of data.resultList?.result ?? []) {
    const title = decodeEntities((record.title ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').replace(/\.$/, '').trim();
    if (!record.id || !title) continue;
    const authors = authorsOf(record);
    const venue = record.journalInfo?.journal?.title ?? record.bookOrReportDetails?.publisher ?? undefined;
    const year = Number(record.pubYear ?? record.journalInfo?.yearOfPublication) || undefined;
    const abstract = abstractText(record.abstractText);
    const pdf = record.fullTextUrlList?.fullTextUrl?.find((link) => link.documentStyle === 'pdf' && link.url && /^(?:OA|F)$/.test(link.availabilityCode ?? ''));
    const byline = [authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : ''), venue, year].filter(Boolean).join(' · ');
    hits.push({
      url: pageUrl(record),
      title,
      snippet: truncate([byline, abstract].filter(Boolean).join(' — '), 320),
      content: abstract || undefined,
      publishedAt: record.firstPublicationDate,
      meta: {
        authors,
        venue,
        year,
        citations: record.citedByCount,
        doi: record.doi?.toLowerCase(),
        pdfUrl: pdf?.url,
      },
    });
  }
  return hits;
}

/** https://europepmc.org/RestfulWebService; no key, `resultType=core` is the one that includes abstracts. */
export const europepmc: SearchSource = {
  id: 'europepmc',
  label: 'Europe PMC',
  modes: ['academic'],
  requiresKey: false,
  async search(query, { env, count, signal }) {
    const params = new URLSearchParams({ query, format: 'json', resultType: 'core', pageSize: String(Math.min(count, 30)) });
    const data = await fetchJson<{ resultList?: { result?: EuropePmcRecord[] } }>(
      env.fetch,
      `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${params}`,
      { signal },
    );
    return parseEuropePmc(data)
      .slice(0, count)
      .map((hit, index): SearchHit => ({ ...hit, source: 'europepmc', rank: index + 1 }));
  },
};
