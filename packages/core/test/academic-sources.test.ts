// The API academic sources. What is real and what is not (see docs/PLAN.md "known gaps" for the long form):
//   REAL captures:  pubmed-esearch.json, pubmed-efetch.xml (reference lists trimmed), europepmc.json, europepmc-preprints.json,
//                   dblp-challenge.html (DBLP's bot check, the answer every request got).
//   HAND-WRITTEN:   dblp.json (the API was behind that bot check, so no real JSON could be had); the test on it only proves the
//                   parser matches the documented shape it was written against.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, usableSources } from '../src/config';
import { SOURCES } from '../src/sources';
import { dblp, parseDblp } from '../src/sources/dblp';
import { europepmc } from '../src/sources/europepmc';
import { parsePubmedXml, pubmed } from '../src/sources/pubmed';
import { normalizeUrl } from '../src/url';
import type { FetchLike, SearchSource } from '../src/types';
import { sourceContext } from './helpers';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Answers each request with the first route whose pattern is in the URL. */
function mockFetch(routes: [string, { body: string; status?: number; type?: string }][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    const route = routes.find(([pattern]) => input.includes(pattern));
    if (!route) throw new Error(`unexpected request ${input}`);
    return new Response(route[1].body, { status: route[1].status ?? 200, headers: { 'Content-Type': route[1].type ?? 'application/json' } });
  };
  return { env: { fetch }, calls };
}

const run = (source: SearchSource, env: { fetch: FetchLike }, settings: { enabled: boolean; apiKey?: string } = { enabled: true }, query = 'crispr base editing') =>
  source.search(query, sourceContext(env, settings));

const paramsOf = (url: string) => new URL(url).searchParams;

describe('PubMed (real esearch + efetch responses)', () => {
  const routes = (esearch = fixture('pubmed-esearch.json')): [string, { body: string; type?: string }][] => [
    ['esearch.fcgi', { body: esearch }],
    ['efetch.fcgi', { body: fixture('pubmed-efetch.xml'), type: 'text/xml' }],
  ];

  it('searches by relevance, then fetches the found records in one request, without a key', async () => {
    const { env, calls } = mockFetch(routes());
    const hits = await run(pubmed, env);
    expect(calls).toHaveLength(2);
    const search = paramsOf(calls[0].url);
    expect(calls[0].url).toMatch(/^https:\/\/eutils\.ncbi\.nlm\.nih\.gov\/entrez\/eutils\/esearch\.fcgi\?/);
    expect(Object.fromEntries(search)).toEqual({ db: 'pubmed', retmode: 'json', sort: 'relevance', retmax: '7', term: 'crispr base editing', tool: 'kiwi-search' });
    const fetched = paramsOf(calls[1].url);
    expect(fetched.get('id')).toBe('38786024,31727474,38909984,30912037,38308006');
    expect(fetched.get('retmode')).toBe('xml');
    expect(fetched.has('api_key')).toBe(false);
    expect(hits.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(hits.every((h) => h.source === 'pubmed')).toBe(true);
  });

  it("sends the user's own key on both requests when one is set", async () => {
    const { env, calls } = mockFetch(routes());
    await run(pubmed, env, { enabled: true, apiKey: 'ncbi-key' });
    expect(calls.map((c) => paramsOf(c.url).get('api_key'))).toEqual(['ncbi-key', 'ncbi-key']);
  });

  it('maps the record: PubMed page URL, clean title, authors, journal, year, DOI, abstract', async () => {
    const { env } = mockFetch(routes());
    const [first] = await run(pubmed, env);
    expect(first.url).toBe('https://pubmed.ncbi.nlm.nih.gov/38786024/');
    expect(first.title).toBe('CRISPR-Based Gene Therapies: From Preclinical to Clinical Treatments');
    expect(first.meta?.authors?.slice(0, 3)).toEqual(['Marine Laurent', 'Marine Geoffroy', 'Giulia Pavani']);
    expect(first.meta).toMatchObject({ venue: 'Cells', year: 2024, doi: '10.3390/cells13100800' });
    expect(first.publishedAt).toBe('2024-05-08');
    // The abstract is the content; entities such as &#x3b2; are decoded.
    expect(first.content).toContain('Casgevy');
    expect(first.content).toContain('β-thalassemia');
    expect(first.content).not.toMatch(/&#x|<[a-z]/i);
    expect(first.snippet.length).toBeLessThanOrEqual(320);
    expect(first.snippet).toMatch(/^Marine Laurent, Marine Geoffroy, Giulia Pavani et al\. · Cells · 2024 — /);
  });

  it("takes each article's own DOI, not one of the hundreds in its reference list", () => {
    const records = parsePubmedXml(fixture('pubmed-efetch.xml'));
    expect(records).toHaveLength(5);
    for (const { hit } of records) expect(hit.meta?.doi).toMatch(/^10\.\d{4,9}\/\S+$/);
    expect(new Set(records.map(({ hit }) => hit.meta?.doi)).size).toBe(5);
  });

  it("keeps esearch's relevance order even if efetch answers in another", async () => {
    const reversed = JSON.parse(fixture('pubmed-esearch.json'));
    reversed.esearchresult.idlist.reverse();
    const { env } = mockFetch(routes(JSON.stringify(reversed)));
    const hits = await run(pubmed, env);
    expect(hits.map((h) => h.url.match(/\/(\d+)\/$/)?.[1])).toEqual(['38308006', '30912037', '38909984', '31727474', '38786024']);
  });

  it('labels structured abstracts and reads season-dated issues (synthetic XML in the real shape)', () => {
    const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">1</PMID><Article>
      <Journal><JournalIssue><PubDate><MedlineDate>2019 Jan-Feb</MedlineDate></PubDate></JournalIssue><Title>A Journal</Title></Journal>
      <ArticleTitle>[Ein übersetzter Titel].</ArticleTitle>
      <Abstract><AbstractText Label="BACKGROUND">Why.</AbstractText><AbstractText Label="METHODS">How.</AbstractText></Abstract>
      <AuthorList><Author><CollectiveName>The Consortium</CollectiveName></Author><Author><LastName>Doe</LastName><Initials>J</Initials></Author></AuthorList>
      </Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    const [{ hit }] = parsePubmedXml(xml);
    expect(hit.title).toBe('Ein übersetzter Titel');
    expect(hit.content).toBe('Background: Why. Methods: How.');
    expect(hit.meta).toMatchObject({ authors: ['The Consortium', 'J Doe'], venue: 'A Journal', year: 2019, doi: undefined });
  });

  it('does nothing for a query PubMed cannot match, and fails loudly over the rate limit', async () => {
    const none = mockFetch([]);
    expect(await run(pubmed, none.env, undefined, '深度学习')).toEqual([]);
    expect(none.calls).toHaveLength(0);
    const limited = mockFetch([['esearch.fcgi', { body: JSON.stringify({ error: 'API rate limit exceeded', count: '4', limit: '3' }) }]]);
    await expect(run(pubmed, limited.env)).rejects.toThrow('API rate limit exceeded');
    const empty = mockFetch([['esearch.fcgi', { body: JSON.stringify({ esearchresult: { idlist: [] } }) }]]);
    expect(await run(pubmed, empty.env)).toEqual([]);
    expect(empty.calls).toHaveLength(1);
  });
});

describe('Europe PMC (real responses)', () => {
  const answer = (name: string) => mockFetch([['europepmc/webservices/rest/search', { body: fixture(name) }]]);

  it('asks for core records as JSON', async () => {
    const { env, calls } = answer('europepmc.json');
    await run(europepmc, env);
    expect(calls[0].url).toMatch(/^https:\/\/www\.ebi\.ac\.uk\/europepmc\/webservices\/rest\/search\?/);
    expect(Object.fromEntries(paramsOf(calls[0].url))).toEqual({ query: 'crispr base editing', format: 'json', resultType: 'core', pageSize: '7' });
  });

  it('maps a PubMed-indexed record, linking PubMed so it merges with the PubMed source', async () => {
    const { env } = answer('europepmc.json');
    const hits = await run(europepmc, env);
    expect(hits).toHaveLength(5);
    expect(hits.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5]);
    const [first] = hits;
    expect(first.url).toBe('https://pubmed.ncbi.nlm.nih.gov/42994815/');
    expect(normalizeUrl(first.url)).toBe(normalizeUrl('https://pubmed.ncbi.nlm.nih.gov/42994815'));
    expect(first.title).toBe('In Vivo CRISPR Base Editing of ANGPTL3 for Durable Lipid Lowering');
    expect(first.meta).toMatchObject({ venue: 'Nature', year: 2026, citations: 0, doi: '10.1038/s41586-026-11233-9' });
    expect(first.meta?.authors?.slice(0, 2)).toEqual(['Taiji Mizoguchi', 'Jamie E DeNizio']);
    expect(first.publishedAt).toBe('2026-11-06');
    expect(first.content).toMatch(/^Circulating concentrations of low-density lipoprotein cholesterol/);
    expect(first.content).not.toMatch(/<\/?sup>/);
  });

  it('maps preprints: Europe PMC page, publisher as venue, abstract without its markup or heading', async () => {
    const { env } = answer('europepmc-preprints.json');
    const hits = await run(europepmc, env);
    expect(hits[0].url).toBe('https://europepmc.org/article/PPR/PPR1357482');
    expect(hits[0].meta).toMatchObject({ venue: 'bioRxiv', year: 2026, doi: '10.64898/2026.10.28.762597' });
    expect(hits[0].content).toMatch(/^Understanding the connectivity of neuronal networks/);
    // `<title>Abstract</title><p>…</p>` markup, as Research Square preprints come.
    expect(hits[1].meta?.venue).toBe('Research Square');
    expect(hits[1].content).toMatch(/^As critical urban public transport infrastructure/);
    for (const hit of hits) expect(hit.content).not.toMatch(/[<>]/);
  });

  it('offers an open-access PDF link when Europe PMC lists one (record edited by hand to add it)', async () => {
    const data = JSON.parse(fixture('europepmc.json'));
    data.resultList.result[0].fullTextUrlList.fullTextUrl.push({ availabilityCode: 'OA', documentStyle: 'pdf', site: 'Europe_PMC', url: 'https://europepmc.org/articles/PMC1?pdf=render' });
    data.resultList.result[1].fullTextUrlList.fullTextUrl.push({ availabilityCode: 'S', documentStyle: 'pdf', site: 'Publisher', url: 'https://publisher.example/paywalled.pdf' });
    const { env } = mockFetch([['search', { body: JSON.stringify(data) }]]);
    const hits = await run(europepmc, env);
    expect(hits[0].meta?.pdfUrl).toBe('https://europepmc.org/articles/PMC1?pdf=render');
    expect(hits[1].meta?.pdfUrl).toBeUndefined();
  });
});

describe('DBLP', () => {
  const answer = (body: string, status = 200, type = 'application/json') => mockFetch([['dblp.org/search/publ/api', { body, status, type }]]);

  it('asks for JSON hits', async () => {
    const { env, calls } = answer(fixture('dblp.json'));
    await run(dblp, env, undefined, 'graph neural network');
    expect(Object.fromEntries(paramsOf(calls[0].url))).toEqual({ q: 'graph neural network', format: 'json', h: '7' });
  });

  it('maps the hand-written fixture: link to the paper, byline snippet, DOI, one author given as a bare object', async () => {
    const { env } = answer(fixture('dblp.json'));
    const hits = await run(dblp, env);
    expect(hits.map((h) => h.rank)).toEqual([1, 2, 3, 4]);
    expect(hits[0]).toMatchObject({
      url: 'https://openreview.net/forum?id=SJU4ayYgl',
      title: 'Semi-Supervised Classification with Graph Convolutional Networks',
      snippet: 'Thomas N. Kipf, Max Welling · ICLR (Poster) · 2017',
      meta: { authors: ['Thomas N. Kipf', 'Max Welling'], venue: 'ICLR (Poster)', year: 2017 },
    });
    expect(hits[0].content).toBeUndefined();
    expect(hits[1].snippet).toBe('Zonghan Wu, Shirui Pan, Fengwen Chen, Guodong Long et al. · IEEE Trans. Neural Networks Learn. Syst. · 2021');
    expect(hits[2].meta).toMatchObject({ authors: ['Jürgen Schmidhuber'], doi: '10.1016/j.neunet.2014.09.003' });
    // A DOI link and an arXiv link are what the DOI / arXiv de-duplication in fusion recognizes.
    expect(normalizeUrl(hits[1].url)).toBe('doi:10.1109/tnnls.2020.2978386');
    expect(normalizeUrl(hits[3].url)).toBe('arxiv:1812.08434');
  });

  it('handles the shapes the JSON API is known to vary in (synthetic)', () => {
    const one = parseDblp({
      result: { hits: { hit: { info: { title: 'Only &amp; One.', authors: { author: [{ text: 'Wei Wang 0001' }, { text: 'Li Na' }] }, venue: ['VLDB', 'Proc. VLDB Endow.'], year: '2020', url: 'https://dblp.org/rec/journals/pvldb/X20', ee: ['not a link', 'https://doi.org/10.1/x'] } } } },
    });
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ title: 'Only & One', url: 'https://doi.org/10.1/x', meta: { authors: ['Wei Wang', 'Li Na'], venue: 'VLDB, Proc. VLDB Endow.', year: 2020 } });
    // No electronic edition: DBLP's own record page.
    expect(parseDblp({ result: { hits: { hit: [{ info: { title: 'No ee', url: 'https://dblp.org/rec/x/Y1' } }] } } })[0].url).toBe('https://dblp.org/rec/x/Y1');
    // Nothing found: `hit` is absent, and a hit with neither link nor title is skipped.
    expect(parseDblp({ result: { hits: {} } })).toEqual([]);
    expect(parseDblp({ result: { hits: { hit: [{ info: { title: 'No link' } }, { info: { url: 'https://dblp.org/rec/x' } }] } } })).toEqual([]);
  });

  it("reports DBLP's bot check (real page, HTTP 202) as an error instead of an empty result", async () => {
    const { env } = answer(fixture('dblp-challenge.html'), 202, 'text/html; charset=utf-8');
    await expect(run(dblp, env)).rejects.toThrow(/bot check/);
    await expect(run(dblp, answer('<html>oops</html>', 200, 'text/html').env)).rejects.toThrow(/not .*JSON|did not answer/);
    await expect(run(dblp, answer('', 503).env)).rejects.toThrow(/503/);
  });

  it('does nothing for a query without Latin letters', async () => {
    const { env, calls } = answer(fixture('dblp.json'));
    expect(await run(dblp, env, undefined, '深度学习')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('the three API academic sources as registered', () => {
  const ids = ['pubmed', 'europepmc', 'dblp'] as const;

  it('serve the academic mode only, and need neither a key nor the browser', () => {
    for (const id of ids) {
      expect(SOURCES[id].modes).toEqual(['academic']);
      expect(SOURCES[id].requiresKey).toBe(false);
      expect(SOURCES[id].requiresBrowser).toBeUndefined();
    }
  });

  it('are on by default only for PubMed, which has no key unless the user sets one', () => {
    const state = Object.fromEntries(
      usableSources(DEFAULT_CONFIG, true, 'academic')
        .filter((s) => (ids as readonly string[]).includes(s.id))
        .map((s) => [s.id, s.reason ?? 'on']),
    );
    expect(state).toEqual({ pubmed: 'on', europepmc: 'disabled', dblp: 'disabled' });
    expect(DEFAULT_CONFIG.sources.pubmed?.apiKey).toBeUndefined();
    expect(usableSources(DEFAULT_CONFIG, true, 'web').find((s) => s.id === 'pubmed')?.reason).toMatch(/not available in web/);
  });
});
