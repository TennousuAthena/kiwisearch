import { matchesAcademicLanguage } from './academicLanguage';
import { paperTitleKey } from './fusion';
import { errorMessage, withTimeout } from './http';
import { chat, llmUsable, type ChatMessage } from './llm';
import { coreMessages } from './messages';
import { searchOpenAlex } from './sources/openalex';
import { SOURCES } from './sources';
import type { AcademicLanguage, AcademicPlan, Env, FusionConfig, SearchHit, SourceId, VerifiedLandmark } from './types';

/** How each source wants its search text, by source id (some are added by other changes). Anything not listed takes plain keywords. */
const QUERY_STYLE: Record<string, string> = {
  pubmed: 'a PubMed query: title/abstract terms with [tiab] and MeSH terms with [MeSH Terms], joined by AND / OR and parentheses',
  baiduxueshu: 'Chinese keywords separated by spaces',
  cnki: 'Chinese keywords separated by spaces',
};

const CURRENT_YEAR = new Date().getFullYear();

export interface NamedPaper {
  title: string;
  year?: number;
}

export interface ParsedPlan {
  plan: AcademicPlan;
  papers: NamedPaper[];
}

/** Added when the search is limited to English-language papers; it wins over the rules above it where they differ (keywords in Chinese too). */
const ENGLISH_ONLY = `

Language limit: the researcher wants English-language papers only. This overrides the rules above where they differ: write every search text and every keyword in English (translate the terms of a query that is in another language), do not add Chinese terms, and name only papers published in English, with their English titles. "intent" stays in the language of the query.`;

function systemPrompt(sourceIds: SourceId[], language?: AcademicLanguage): string {
  const queryLines = sourceIds.map((id) => `    "${id}": ${QUERY_STYLE[id] ?? 'a short plain keyword query, no operators'}`).join(',\n');
  return `You help a researcher search scholarly databases. You get a short search query. Work out what the researcher most likely wants to find, then write search text for each database and name the papers they are most likely after.

Reply with one JSON object and nothing else:
{
  "intent": "one short sentence, in the language of the query, saying what they probably want to find",
  "keywords": ["3 to 8 search terms or phrases: English first, plus the Chinese term when the query is Chinese or the topic has a standard Chinese name; include common synonyms"],
  "queries": {
${queryLines}
  },
  "papers": [{"title": "the exact title of one paper", "year": 2017}]
}

Rules for "papers":
- Up to 5 papers a researcher who typed this query would want to see first: the foundational paper, the best-known follow-ups or surveys, the ones everybody cites.
- If the query names or clearly describes one specific paper, that paper comes first.
- Only name a paper you are sure exists, with its exact published title. If you are unsure, name fewer, or none. Never make one up: every title is checked against a bibliographic index and the ones that are not found are thrown away.
- "year" is the year it first appeared, or omit it if unsure.${language === 'en' ? ENGLISH_ONLY : ''}`;
}

export function buildPlanMessages(query: string, sourceIds: SourceId[], language?: AcademicLanguage): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt(sourceIds, language) },
    { role: 'user', content: JSON.stringify({ query }) },
  ];
}

const oneLine = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** The model's reply as a plan, or null when it is not one. Everything is clamped: the reply is data, not instructions to follow. */
export function parsePlan(text: string, sourceIds: SourceId[], maxPapers: number): ParsedPlan | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object') return null;
  const object = raw as Record<string, unknown>;
  const intent = oneLine(object.intent, 200);
  const keywords = [...new Set((Array.isArray(object.keywords) ? object.keywords : []).map((k) => oneLine(k, 80)).filter(Boolean))].slice(0, 8);
  const queries: AcademicPlan['queries'] = {};
  if (object.queries && typeof object.queries === 'object') {
    for (const id of sourceIds) {
      const text = oneLine((object.queries as Record<string, unknown>)[id], 240);
      if (text) queries[id] = text;
    }
  }
  const papers: NamedPaper[] = [];
  for (const item of Array.isArray(object.papers) ? object.papers : []) {
    const title = oneLine((item as { title?: unknown })?.title, 250);
    const year = Number((item as { year?: unknown })?.year);
    if (title.length >= 6 && !papers.some((p) => paperTitleKey(p.title) === paperTitleKey(title))) {
      papers.push({ title, ...(Number.isInteger(year) && year >= 1500 && year <= CURRENT_YEAR + 1 ? { year } : {}) });
    }
  }
  if (!intent && !keywords.length && !papers.length) return null;
  return { plan: { intent, keywords, queries }, papers: papers.slice(0, maxPapers) };
}

/** The sources a second round of search can run on: academic, API-backed (no tab to queue, no captcha to risk) and switched on. */
export function planSourceIds(config: FusionConfig): SourceId[] {
  return (Object.keys(SOURCES) as SourceId[]).filter((id) => {
    const source = SOURCES[id];
    return source.modes.includes('academic') && !source.requiresBrowser && !!config.sources[id]?.enabled && (!source.requiresKey || !!config.sources[id]?.apiKey);
  });
}

export async function planAcademicQuery(query: string, config: FusionConfig, env: Env, signal?: AbortSignal, language?: AcademicLanguage): Promise<{ parsed?: ParsedPlan; error?: string }> {
  const messages = coreMessages(env);
  if (!llmUsable(config.llm)) return { error: messages.noAiModel };
  const sourceIds = planSourceIds(config);
  try {
    const text = await chat(env.fetch, config.llm, buildPlanMessages(query, sourceIds, language), { signal, json: true });
    const parsed = parsePlan(text, sourceIds, config.academic.landmarks);
    return parsed ? { parsed } : { error: messages.planInvalid };
  } catch (e) {
    if (signal?.aborted && !(signal.reason instanceof Error && /^timeout/.test(signal.reason.message))) throw e;
    return { error: errorMessage(signal?.aborted ? signal.reason : e) };
  }
}

/** Same paper, as two index entries would spell it: equal titles, or one containing the other with at most a subtitle's worth of difference. */
export function sameTitle(left: string, right: string): boolean {
  const a = paperTitleKey(left);
  const b = paperTitleKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 12 && long.includes(short) && short.length / long.length >= 0.6;
}

/**
 * Looks each named paper up by title in OpenAlex (Crossref when OpenAlex is off) and keeps the ones that exist, as the
 * index spells them. A paper the index doesn't have is dropped: the model's memory alone never puts a paper on the page.
 */
export async function verifyPapers(papers: NamedPaper[], config: FusionConfig, env: Env, signal?: AbortSignal, language?: AcademicLanguage): Promise<SearchHit[]> {
  const viaOpenAlex = !!config.sources.openalex?.enabled;
  const viaCrossref = !!config.sources.crossref?.enabled;
  if (!viaOpenAlex && !viaCrossref) return [];
  const lookups = await Promise.all(
    papers.map(async (paper): Promise<SearchHit | undefined> => {
      try {
        const candidates = viaOpenAlex
          ? await searchOpenAlex(env, config.sources.openalex!, paper.title, { count: 5, signal, language })
          : await SOURCES.crossref.search(paper.title, { env, settings: config.sources.crossref!, mode: 'academic', count: 5, signal: signal ?? new AbortController().signal, onBlocked: () => {}, onStart: () => {}, renderer: config.renderer });
        const matches = candidates.filter(
          (hit) => sameTitle(paper.title, hit.title) && matchesAcademicLanguage(hit.title, language) && (paper.year === undefined || hit.meta?.year === undefined || Math.abs(hit.meta.year - paper.year) <= 1),
        );
        // A paper is often indexed twice (preprint and journal version); the one people cite is the one to show.
        return matches.sort((x, y) => (y.meta?.citations ?? 0) - (x.meta?.citations ?? 0))[0];
      } catch (e) {
        if (signal?.aborted) throw e;
        return undefined;
      }
    }),
  );
  return lookups.filter((hit): hit is SearchHit => !!hit).map((hit, index) => ({ ...hit, rank: index + 1 }));
}

/** The papers that were found, as the page needs to name them. */
export function landmarksOf(hits: SearchHit[]): VerifiedLandmark[] {
  return hits.map((hit) => ({ title: hit.title, ...(hit.meta?.year !== undefined ? { year: hit.meta.year } : {}), ...(hit.meta?.doi ? { doi: hit.meta.doi } : {}) }));
}

/** The second-round searches, one per API source whose planned text differs from what the user typed. */
export async function searchWithPlan(
  query: string,
  plan: AcademicPlan,
  sourceIds: SourceId[],
  config: FusionConfig,
  env: Env,
  count: number,
  signal?: AbortSignal,
  language?: AcademicLanguage,
): Promise<{ lists: SearchHit[][]; used: AcademicPlan['queries'] }> {
  const lists: SearchHit[][] = [];
  const used: AcademicPlan['queries'] = {};
  const sameAsTyped = (text: string) => text.toLowerCase() === query.toLowerCase();
  await Promise.all(
    sourceIds.map(async (id) => {
      const text = plan.queries[id];
      if (!text || sameAsTyped(text)) return;
      const deadline = withTimeout(signal, config.sourceTimeoutMs);
      try {
        const hits = await SOURCES[id].search(text, { env, settings: config.sources[id]!, mode: 'academic', language, count, signal: deadline.signal, onBlocked: () => {}, onStart: () => {}, renderer: config.renderer });
        if (hits.length) {
          lists.push(hits);
          used[id] = text;
        }
      } catch {
        // One source failing leaves the rest of the second round standing.
      } finally {
        deadline.cancel();
      }
    }),
  );
  // The most-cited pass: the papers everyone cites on this topic, which the model's own list and a relevance search can both miss.
  if (sourceIds.includes('openalex')) {
    const text = plan.queries.openalex ?? plan.keywords.slice(0, 3).join(' ');
    if (text) {
      const deadline = withTimeout(signal, config.sourceTimeoutMs);
      try {
        const hits = await searchOpenAlex(env, config.sources.openalex!, text, { count: 5, signal: deadline.signal, sort: 'cited_by_count:desc', language });
        if (hits.length) lists.push(hits);
      } catch {
        // as above
      } finally {
        deadline.cancel();
      }
    }
  }
  return { lists, used };
}
