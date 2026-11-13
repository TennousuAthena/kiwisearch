// Limiting an academic search to English-language papers. The requests are checked against the parameters each service documents
// and that were tried with real requests (OpenAlex `filter=language:en`, PubMed `english[la]`, Europe PMC `LANG:eng`); Google
// Scholar's `lr=lang_en` is the documented "search language" parameter and was not run in a browser. Everything else here is
// synthetic: a fake fetch that records what it was asked and answers with a few works.
import { describe, expect, it } from 'vitest';
import { applyAcademicLanguage, hasCjk, isEnglishTitle, matchesAcademicLanguage } from '../src/academicLanguage';
import { buildPlanMessages, verifyPapers } from '../src/academic';
import { DEFAULT_CONFIG } from '../src/config';
import { scholar } from '../src/engines/scholar';
import { runSearch } from '../src/pipeline';
import { europepmc } from '../src/sources/europepmc';
import { openalex } from '../src/sources/openalex';
import { pubmed } from '../src/sources/pubmed';
import { isAcademicLanguage, type Env, type FusedResult, type FusionConfig, type SourceCache } from '../src/types';
import { sourceContext } from './helpers';

const result = (title: string, extra: Partial<FusedResult> = {}): FusedResult => ({
  key: title,
  url: `https://example.org/${encodeURIComponent(title)}`,
  title,
  snippet: '',
  sources: [{ source: 'crossref', rank: 1 }],
  rrfScore: 1,
  score: 1,
  meta: {},
  ...extra,
});

describe('reading a title as English', () => {
  it('accepts Latin-script titles, with symbols, Greek letters and digits', () => {
    for (const title of ['Attention Is All You Need', 'α-synuclein aggregation in vitro', 'BERT: Pre-training (2018)', 'Über die Quantentheorie']) {
      expect(isEnglishTitle(title), title).toBe(true);
    }
  });

  it('refuses Chinese, Japanese and Korean titles, and a title that quotes a Chinese term', () => {
    for (const title of ['深度学习综述', 'ディープラーニングの研究', '딥러닝 연구', 'Deep Learning 与 医学', 'A study of 红楼梦']) {
      expect(isEnglishTitle(title), title).toBe(false);
    }
  });

  it('refuses a title with no Latin letters at all', () => {
    for (const title of ['', '2020', 'Нейронные сети']) expect(isEnglishTitle(title), title).toBe(false);
  });

  it('limits nothing unless the language is English', () => {
    expect(matchesAcademicLanguage('深度学习综述', undefined)).toBe(true);
    expect(matchesAcademicLanguage('深度学习综述', 'any')).toBe(true);
    expect(matchesAcademicLanguage('深度学习综述', 'en')).toBe(false);
    expect(hasCjk('深度学习 review')).toBe(true);
    expect(hasCjk('deep learning')).toBe(false);
  });

  it('knows the two languages and nothing else', () => {
    expect(['any', 'en'].every(isAcademicLanguage)).toBe(true);
    for (const value of ['zh', 'EN', '', undefined, 3]) expect(isAcademicLanguage(value)).toBe(false);
  });
});

describe('hiding the results that are not in the language', () => {
  const list = [result('深度学习综述'), result('Deep learning'), result('Nature of things', { hidden: { reason: 'blocked' } }), result('机器学习', { hidden: { reason: 'junk' } })];

  it('hands the same list back when there is no limit', () => {
    expect(applyAcademicLanguage(list, undefined)).toBe(list);
    expect(applyAcademicLanguage(list, 'any')).toBe(list);
  });

  it('hides a non-English title as "language", moves it behind the rest and keeps the other reasons', () => {
    const out = applyAcademicLanguage(list, 'en');
    expect(out.map((r) => [r.title, r.hidden?.reason])).toEqual([
      ['Deep learning', undefined],
      ['深度学习综述', 'language'],
      ['Nature of things', 'blocked'],
      ['机器学习', 'junk'],
    ]);
    // Not modified in place: the input still shows what the engines returned.
    expect(list[0].hidden).toBeUndefined();
  });

  it('is safe to repeat on every merge', () => {
    const once = applyAcademicLanguage(list, 'en');
    expect(applyAcademicLanguage(once, 'en')).toBe(once);
  });
});

/** Records every request and answers each service with an empty result of the right shape. */
function recorder(answer: (url: URL) => unknown = () => ({})) {
  const urls: URL[] = [];
  const fetch: Env['fetch'] = async (input) => {
    const url = new URL(input);
    urls.push(url);
    if (url.hostname === 'api.openalex.org') return new Response(JSON.stringify(answer(url) ?? { results: [] }));
    if (url.hostname === 'api.crossref.org') return new Response(JSON.stringify(answer(url) ?? { message: { items: [] } }));
    if (url.pathname.endsWith('esearch.fcgi')) return new Response(JSON.stringify({ esearchresult: { idlist: [] } }));
    if (url.hostname === 'www.ebi.ac.uk') return new Response(JSON.stringify({ resultList: { result: [] } }));
    throw new Error(`unexpected request ${input}`);
  };
  return { env: { fetch } as Env, urls };
}

describe('asking each source for English-language papers', () => {
  it('OpenAlex gets filter=language:en, and no filter without the limit', async () => {
    const { env, urls } = recorder(() => ({ results: [] }));
    await openalex.search('deep learning', sourceContext(env, { enabled: true }, { language: 'en' }));
    await openalex.search('deep learning', sourceContext(env, { enabled: true }));
    expect(urls[0].searchParams.get('filter')).toBe('language:en');
    expect(urls[0].searchParams.get('search')).toBe('deep learning');
    expect(urls[1].searchParams.has('filter')).toBe(false);
  });

  it('PubMed adds english[la] to the whole query, and leaves the query alone without the limit', async () => {
    const { env, urls } = recorder();
    await pubmed.search('crispr OR "base editing"', sourceContext(env, { enabled: true }, { language: 'en' }));
    await pubmed.search('crispr OR "base editing"', sourceContext(env, { enabled: true }));
    expect(urls[0].searchParams.get('term')).toBe('(crispr OR "base editing") AND english[la]');
    expect(urls[1].searchParams.get('term')).toBe('crispr OR "base editing"');
  });

  it('Europe PMC adds LANG:eng to the whole query, and leaves the query alone without the limit', async () => {
    const { env, urls } = recorder();
    await europepmc.search('crispr OR base editing', sourceContext(env, { enabled: true }, { language: 'en' }));
    await europepmc.search('crispr OR base editing', sourceContext(env, { enabled: true }));
    expect(urls[0].searchParams.get('query')).toBe('(crispr OR base editing) AND LANG:eng');
    expect(urls[1].searchParams.get('query')).toBe('crispr OR base editing');
  });

  it('Google Scholar gets lr=lang_en in its address, and the address is unchanged without the limit', () => {
    const limited = new URL(scholar.buildUrl('深度学习', 10, 'academic', 'en'));
    expect(limited.searchParams.get('lr')).toBe('lang_en');
    expect(limited.searchParams.get('q')).toBe('深度学习');
    expect(scholar.buildUrl('深度学习', 10, 'academic')).toBe('https://scholar.google.com/scholar?q=%E6%B7%B1%E5%BA%A6%E5%AD%A6%E4%B9%A0&num=10');
  });

  it('the paper check of the smart search asks OpenAlex for English too', async () => {
    const { env, urls } = recorder(() => ({ results: [] }));
    const config = structuredClone(DEFAULT_CONFIG);
    await verifyPapers([{ title: 'Attention Is All You Need' }], config, env, undefined, 'en');
    expect(urls[0].searchParams.get('filter')).toBe('language:en');
  });

  it('the plan prompt demands English only when the search is limited', () => {
    const limited = buildPlanMessages('深度学习', ['openalex'], 'en')[0].content;
    expect(limited).toContain('English-language papers only');
    expect(limited).toContain('do not add Chinese terms');
    expect(buildPlanMessages('深度学习', ['openalex'])[0].content).not.toContain('English-language papers only');
    expect(buildPlanMessages('深度学习', ['openalex'], 'any')[0].content).not.toContain('English-language papers only');
  });
});

function academicConfig(...enabled: string[]): FusionConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = enabled.includes(id);
  config.summary.enabled = false;
  config.judge.provider = 'none';
  config.rerank.provider = 'none';
  return config;
}

const crossrefItem = (doi: string, title: string) => ({ DOI: doi, title: [title], author: [{ given: 'A.', family: 'Author' }], issued: { 'date-parts': [[2020]] } });

describe('an academic search limited to English', () => {
  // Crossref has no language filter, so what it returns is sorted out by title.
  const answer = (url: URL) =>
    url.hostname === 'api.crossref.org'
      ? { message: { items: [crossrefItem('10.1/a', '深度学习研究综述'), crossrefItem('10.1/b', 'Deep learning: a review')] } }
      : { results: [] };

  it('hides the papers whose title is not English, behind the others, with the reason', async () => {
    const { env, urls } = recorder(answer);
    const found = await runSearch('deep learning', academicConfig('crossref', 'openalex'), env, { mode: 'academic', language: 'en' });
    expect(found.results.map((r) => [r.title, r.hidden?.reason])).toEqual([
      ['Deep learning: a review', undefined],
      ['深度学习研究综述', 'language'],
    ]);
    expect(urls.find((u) => u.hostname === 'api.openalex.org')?.searchParams.get('filter')).toBe('language:en');
    expect(urls.find((u) => u.hostname === 'api.crossref.org')?.searchParams.has('filter')).toBe(false);
  });

  it('limits nothing by default, or with "any"', async () => {
    for (const opts of [{ mode: 'academic' as const }, { mode: 'academic' as const, language: 'any' as const }]) {
      const { env, urls } = recorder(answer);
      const found = await runSearch('deep learning', academicConfig('crossref', 'openalex'), env, opts);
      expect(found.results.every((r) => !r.hidden)).toBe(true);
      expect(urls.find((u) => u.hostname === 'api.openalex.org')?.searchParams.has('filter')).toBe(false);
    }
  });

  it('ignores the option outside academic mode', async () => {
    const { env, urls } = recorder(() => ({ results: [] }));
    const config = academicConfig('openalex');
    config.sources.exa = { enabled: true, apiKey: 'exa-test-key' };
    // Exa is a web source; the limit must not reach a general search, where a Chinese title is as good as any.
    const seen: string[] = [];
    const exaEnv: Env = { fetch: async (input, init) => (input.startsWith('https://api.exa.ai') ? (seen.push(String(init?.body)), new Response(JSON.stringify({ results: [{ url: 'https://a.example/', title: '深度学习入门' }] }))) : env.fetch(input, init)) };
    const found = await runSearch('深度学习', config, exaEnv, { mode: 'web', language: 'en', sources: ['exa'] });
    expect(found.results.map((r) => [r.title, r.hidden])).toEqual([['深度学习入门', undefined]]);
    expect(seen).toHaveLength(1);
    expect(urls).toHaveLength(0);
  });

  it('does not reuse cached results across the two settings', async () => {
    const store = new Map<string, never>();
    const cache = { get: (key: string) => store.get(key), set: (key: string, hits: never) => void store.set(key, hits) } as unknown as SourceCache;
    // A source that has a hit, since an empty answer is not cached.
    const { env, urls } = recorder(() => ({ results: [{ id: 'https://openalex.org/W1', display_name: 'Deep learning', publication_year: 2015, authorships: [] }] }));
    const config = academicConfig('openalex');
    for (const language of ['en', 'en', undefined] as const) {
      await runSearch('deep learning', config, { ...env, cache }, { mode: 'academic', language });
    }
    // The second English search is answered from the cache; the unlimited one is a different search.
    expect(urls.map((u) => u.searchParams.get('filter'))).toEqual(['language:en', null]);
  });
});
