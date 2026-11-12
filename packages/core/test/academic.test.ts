import { describe, expect, it } from 'vitest';
import { buildPlanMessages, parsePlan, planAcademicQuery, planSourceIds, sameTitle, verifyPapers } from '../src/academic';
import { DEFAULT_CONFIG } from '../src/config';
import { runSearch } from '../src/pipeline';
import type { Env, FusionConfig, PipelineEvent, SourceId } from '../src/types';

const ACADEMIC: SourceId[] = ['openalex', 'crossref', 'arxiv'];

function configFor(...enabled: string[]): FusionConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = enabled.includes(id);
  config.llm = { baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'm' };
  config.summary.enabled = false;
  config.judge.provider = 'none';
  config.rerank.provider = 'none';
  return config;
}

const PLAN = {
  intent: '想找 Transformer 架构的原始论文和相关综述',
  keywords: ['transformer', 'self-attention', 'attention mechanism', 'transformer', '  '],
  queries: { openalex: 'transformer self-attention neural network', crossref: 'transformer attention neural network', arxiv: 'transformer attention', ignored: 'not a source' },
  papers: [
    { title: 'Attention Is All You Need', year: 2017 },
    { title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', year: 2018 },
    { title: 'A Paper That Does Not Exist Anywhere In The Index', year: 2021 },
  ],
};

const work = (title: string, year: number, cited: number, id: string) => ({
  id: `https://openalex.org/${id}`,
  doi: `https://doi.org/10.1000/${id}`,
  display_name: title,
  publication_year: year,
  publication_date: `${year}-06-01`,
  cited_by_count: cited,
  authorships: [{ author: { display_name: 'A. Author' } }],
  primary_location: { landing_page_url: `https://example.org/${id}`, source: { display_name: 'NeurIPS' } },
});

/** A fake LLM and a fake OpenAlex that only knows two papers. `llmBody` is what the model says. */
function world(llmBody: unknown = PLAN, opts: { llmStatus?: number; llmDelayMs?: number } = {}) {
  const openalexQueries: { search: string; sort: string | null }[] = [];
  const crossrefQueries: string[] = [];
  const llmRequests: { messages: { role: string; content: string }[] }[] = [];
  const known = [
    work('Attention Is All You Need', 2017, 120000, 'W1'),
    work('Attention Is All You Need', 2017, 300, 'W1b'), // a lesser duplicate entry of the same paper
    work('BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', 2019, 90000, 'W2'),
    work('An unrelated study of attention in classrooms', 2015, 12, 'W3'),
  ];
  const fetch: Env['fetch'] = async (input, init) => {
    init?.signal?.throwIfAborted();
    if (input.startsWith('https://llm.example')) {
      llmRequests.push(JSON.parse(String(init?.body)));
      if (opts.llmDelayMs) {
        // Like a real fetch: the wait ends with a rejection the moment the signal is aborted.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, opts.llmDelayMs);
          init?.signal?.addEventListener('abort', () => (clearTimeout(timer), reject(init.signal!.reason)), { once: true });
        });
      }
      if (opts.llmStatus) return new Response('boom', { status: opts.llmStatus });
      return new Response(JSON.stringify({ choices: [{ message: { content: typeof llmBody === 'string' ? llmBody : JSON.stringify(llmBody) } }] }));
    }
    if (input.startsWith('https://api.openalex.org')) {
      const url = new URL(input);
      const search = url.searchParams.get('search') ?? '';
      openalexQueries.push({ search, sort: url.searchParams.get('sort') });
      const words = search.toLowerCase().split(/\s+/);
      const hits = known.filter((w) => words.some((word) => word.length > 3 && w.display_name.toLowerCase().includes(word)));
      return new Response(JSON.stringify({ results: url.searchParams.get('sort') ? [known[0], known[2]] : hits.slice(0, 5) }));
    }
    if (input.startsWith('https://api.crossref.org')) {
      crossrefQueries.push(new URL(input).searchParams.get('query') ?? '');
      return new Response(JSON.stringify({ message: { items: [] } }));
    }
    if (input.startsWith('https://export.arxiv.org')) return new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>');
    throw new Error(`unexpected fetch ${input}`);
  };
  return { env: { fetch } as Env, openalexQueries, crossrefQueries, llmRequests };
}

describe('parsePlan', () => {
  it('keeps a clean plan, drops what is not usable, and caps everything', () => {
    const parsed = parsePlan(JSON.stringify(PLAN), ACADEMIC, 5)!;
    expect(parsed.plan.intent).toBe(PLAN.intent);
    expect(parsed.plan.keywords).toEqual(['transformer', 'self-attention', 'attention mechanism']);
    expect(parsed.plan.queries).toEqual({ openalex: PLAN.queries.openalex, crossref: PLAN.queries.crossref, arxiv: PLAN.queries.arxiv });
    expect(parsed.papers).toHaveLength(3);
    expect(parsePlan(JSON.stringify(PLAN), ACADEMIC, 2)!.papers).toHaveLength(2);
  });

  it('finds the JSON inside a fenced or chatty reply', () => {
    expect(parsePlan('Sure!\n```json\n{"intent":"x","keywords":["a"]}\n```', ACADEMIC, 5)?.plan.keywords).toEqual(['a']);
  });

  it('refuses a reply that is not a plan', () => {
    expect(parsePlan('I cannot help with that.', ACADEMIC, 5)).toBeNull();
    expect(parsePlan('{"intent":"","keywords":[],"papers":[]}', ACADEMIC, 5)).toBeNull();
    expect(parsePlan('[1,2]', ACADEMIC, 5)).toBeNull();
  });

  it('ignores impossible years and too-short titles, and does not repeat a paper', () => {
    const parsed = parsePlan(JSON.stringify({ intent: 'x', papers: [{ title: 'Attention Is All You Need', year: 99999 }, { title: 'attention is all you need!' }, { title: 'Hi' }] }), ACADEMIC, 5)!;
    expect(parsed.papers).toEqual([{ title: 'Attention Is All You Need' }]);
  });
});

describe('planning', () => {
  it('asks the model only about the academic API sources that are on, and sends the query as data', () => {
    const config = configFor('openalex', 'crossref', 'scholar', 'brave');
    expect(planSourceIds(config).sort()).toEqual(['crossref', 'openalex']);
    const [system, user] = buildPlanMessages('transformer', ['openalex']);
    expect(system.content).toContain('"openalex"');
    expect(system.content).not.toContain('"crossref"');
    expect(user.content).toBe('{"query":"transformer"}');
  });

  it('reports why there is no plan instead of throwing', async () => {
    const config = configFor('openalex');
    expect(await planAcademicQuery('q', config, world(PLAN, { llmStatus: 401 }).env)).toMatchObject({ error: expect.stringContaining('401') });
    expect(await planAcademicQuery('q', config, world('no json at all').env)).toMatchObject({ error: expect.stringContaining('检索计划') });
    config.llm.apiKey = '';
    expect(await planAcademicQuery('q', config, world().env)).toMatchObject({ error: expect.any(String) });
  });
});

describe('verifying the papers the model named', () => {
  it('compares titles the way an index spells them', () => {
    expect(sameTitle('Attention Is All You Need', 'Attention is all you need.')).toBe(true);
    expect(sameTitle('BERT: Pre-training of Deep Bidirectional Transformers', 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding')).toBe(true);
    expect(sameTitle('Attention Is All You Need', 'An unrelated study of attention in classrooms')).toBe(false);
    expect(sameTitle('Attention', 'Attention Is All You Need')).toBe(false);
    expect(sameTitle('', 'x')).toBe(false);
  });

  it('keeps what the index has (the most-cited entry of a duplicate), drops what it has not, and tolerates a year off by one', async () => {
    const { env } = world();
    const hits = await verifyPapers(parsePlan(JSON.stringify(PLAN), ACADEMIC, 5)!.papers, configFor('openalex'), env);
    expect(hits.map((h) => h.title)).toEqual(['Attention Is All You Need', 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding']);
    expect(hits[0].meta?.citations).toBe(120000);
    expect(hits.map((h) => h.rank)).toEqual([1, 2]);
  });

  it('cannot verify anything when no bibliographic index is switched on, so it shows nothing', async () => {
    expect(await verifyPapers([{ title: 'Attention Is All You Need' }], configFor('arxiv'), world().env)).toEqual([]);
  });

  it('falls back to Crossref when OpenAlex is off', async () => {
    const { env, crossrefQueries, openalexQueries } = world();
    await verifyPapers([{ title: 'Attention Is All You Need' }], configFor('crossref'), env);
    expect(crossrefQueries).toEqual(['Attention Is All You Need']);
    expect(openalexQueries).toEqual([]);
  });
});

describe('an academic search with a plan', () => {
  it('shows the paper the model named even though the typed query alone would not find it', async () => {
    const { env, openalexQueries } = world();
    const events: PipelineEvent[] = [];
    // The typed query "transformer" matches no title in the fake index; only the named paper and the most-cited pass do.
    const result = await runSearch('transformer', configFor('openalex', 'crossref', 'arxiv'), env, { mode: 'academic', onEvent: (e) => events.push(e) });
    const titles = result.results.map((r) => r.title);
    expect(titles[0]).toBe('Attention Is All You Need');
    expect(titles).toContain('BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding');
    expect(titles).not.toContain('A Paper That Does Not Exist Anywhere In The Index');
    expect(result.landmarks?.map((l) => l.title)).toEqual(['Attention Is All You Need', 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding']);
    expect(result.plan?.intent).toBe(PLAN.intent);
    expect(result.plan?.queries).toMatchObject({ openalex: PLAN.queries.openalex });
    expect(openalexQueries.some((q) => q.sort === 'cited_by_count:desc')).toBe(true);
    const plan = events.find((e) => e.type === 'academic_plan');
    expect(plan).toMatchObject({ landmarks: [{ title: 'Attention Is All You Need', year: 2017 }, { year: 2019 }] });
  });

  it('is the plain search without a usable model, with smart search off, with explicit sources, or outside academic mode', async () => {
    const cases: [string, (c: FusionConfig) => void, Parameters<typeof runSearch>[3]][] = [
      ['no key', (c) => (c.llm.apiKey = ''), { mode: 'academic' }],
      ['switched off', (c) => (c.academic.smart = false), { mode: 'academic' }],
      ['explicit sources', () => {}, { mode: 'academic', sources: ['openalex'] }],
      ['another mode', () => {}, { mode: 'web' }],
    ];
    for (const [name, change, runOpts] of cases) {
      const w = world();
      const config = configFor('openalex', 'duckduckgo');
      change(config);
      const env: Env = { ...w.env, runBrowserEngine: async () => [] };
      await runSearch('transformer', config, env, runOpts).catch(() => undefined);
      expect(w.llmRequests, name).toHaveLength(0);
    }
  });

  it('carries on with the plain results when the model fails, and says so', async () => {
    const { env } = world(PLAN, { llmStatus: 500 });
    const events: PipelineEvent[] = [];
    const result = await runSearch('transformer', configFor('openalex'), env, { mode: 'academic', onEvent: (e) => events.push(e) });
    expect(result.plan).toBeUndefined();
    expect(events.find((e) => e.type === 'academic_plan')).toMatchObject({ landmarks: [], error: expect.stringContaining('500') });
  });

  it('gives up on a model that is too slow, within its own limit', async () => {
    const config = configFor('openalex');
    config.academic.timeoutMs = 60;
    const started = Date.now();
    const events: PipelineEvent[] = [];
    await runSearch('transformer', config, world(PLAN, { llmDelayMs: 400 }).env, { mode: 'academic', onEvent: (e) => events.push(e) });
    expect(Date.now() - started).toBeLessThan(350);
    expect(events.find((e) => e.type === 'academic_plan')).toMatchObject({ error: expect.stringMatching(/timeout|60/) });
  });

  it('waits for the plan past the soft deadline, so its papers are in the first full list', async () => {
    const config = configFor('openalex');
    const result = await runSearch('transformer', config, world(PLAN, { llmDelayMs: 120 }).env, { mode: 'academic', softDeadlineMs: 20 });
    expect(result.results[0].title).toBe('Attention Is All You Need');
  });
});
