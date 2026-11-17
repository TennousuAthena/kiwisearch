import { askDecision, decisionModelUsable } from './decision';
import { errorMessage, withTimeout } from './http';
import type { Citation, Env, FusedResult, FusionConfig, SummaryCheckReason } from './types';

/** How much of the overview and of each cited excerpt the decision model is shown. */
const OVERVIEW_CHARS = 4000;
const EXCERPT_CHARS = 400;

/**
 * One System One question: does the overview written from the first results already answer the query, so the rest of the results
 * would not change it much? Without the overview's text (the browser's built-in model writes it in the page) only the evidence is judged.
 */
export function buildSufficiencyRequest(query: string, overview: string | undefined, evidence: FusedResult[], model: string) {
  const cited = evidence.map((result, i) => ({ n: i + 1, title: result.title, url: result.url, excerpt: (result.snippet ?? '').slice(0, EXCERPT_CHARS) }));
  return {
    model,
    state: overview ? { query, overview: overview.slice(0, OVERVIEW_CHARS), evidence: cited } : { query, evidence: cited },
    questions: {
      sufficient: {
        type: 'noul',
        instructions: overview
          ? '`overview` was written quickly for `query` from the first search results, listed in `evidence` (it cites them as [n]). Is it already a good answer: on topic, supported by relevant evidence, and unlikely to change much if more search results arrived?'
          : '`evidence` lists the first search results for `query`. Are they already relevant and sufficient to answer it well, so that more search results are unlikely to change the answer much?',
        criteria: {
          true: 'The evidence is on topic and answers what the query asks; more results would add little',
          false: 'The evidence is off topic, thin, contradictory, outdated for a changing fact, or misses an important part of what the query asks',
        },
      },
    },
  };
}

export interface SufficiencyVerdict {
  keep: boolean;
  reason: SummaryCheckReason;
  score?: number;
  error?: string;
}

/** Ask whether the early overview stands. No decision model, an error or no answer in time means it does not: the final one is written. */
export async function judgeSufficiency(
  query: string, overview: string | undefined, evidence: FusedResult[], config: FusionConfig, env: Env, signal?: AbortSignal,
): Promise<SufficiencyVerdict> {
  if (!decisionModelUsable(config)) return { keep: false, reason: 'no-model' };
  const deadline = withTimeout(signal, config.judge.timeoutMs);
  try {
    const { answers } = await askDecision(env, config, buildSufficiencyRequest(query, overview, evidence, config.judge.model), deadline.signal);
    const score = answers.sufficient?.noul;
    if (typeof score !== 'number') return { keep: false, reason: 'error' };
    const keep = score >= config.summary.early.keepThreshold;
    return { keep, reason: keep ? 'sufficient' : 'insufficient', score };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { keep: false, reason: 'error', error: errorMessage(deadline.signal.aborted ? deadline.signal.reason : e) };
  } finally {
    deadline.cancel();
  }
}

/** Whether judging hid a result the early overview cites, which would leave it standing on junk or an irrelevant page. */
export function citesHidden(citations: Citation[], results: FusedResult[]): boolean {
  return citations.some((citation) => results.some((result) => result.url === citation.url && result.hidden));
}
