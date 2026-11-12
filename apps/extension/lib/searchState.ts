import type { AcademicPlan, BlockReason, Citation, FusedResult, IntentSuggestion, PipelineEvent, SearchMode, SourceId, VerifiedLandmark } from '@kiwi-search/core';

export type SummaryStatus = 'idle' | 'loading' | 'starting' | 'streaming' | 'done' | 'error';

export interface SearchState {
  query: string;
  mode: SearchMode;
  startedAt: number;
  finishedAt?: number;
  /** Sources still running. Only used to tell whether more results may arrive; never shown by name. */
  running: SourceId[];
  /** Sources waiting on a captcha or a login; the page offers one action per kind. */
  blocked: SourceId[];
  blockedBy: Partial<Record<SourceId, BlockReason>>;
  results: FusedResult[];
  stage: 'searching' | 'refining' | 'done';
  /** Set when the decision model failed or timed out; results fall back to the plain fused order. */
  judgeError?: string;
  /** General search: the decision model could not say whether to also search the platforms (so only the general sources ran). Absent when it answered, or was not asked (no key). */
  intentError?: string;
  /** The tab the decision model thinks the user wants (images, video, academic), from a general search's verdict. */
  suggest?: IntentSuggestion;
  /** Academic mode: what the user's model understood, the papers it named that were found to exist, or why there is no plan. */
  plan?: AcademicPlan;
  landmarks: VerifiedLandmark[];
  planError?: string;
  citations: Citation[];
  summary: string;
  summaryStatus: SummaryStatus;
  summaryError?: string;
  fatal?: string;
}

export const emptyState = (query: string, mode: SearchMode, now = Date.now()): SearchState => ({
  query,
  mode,
  startedAt: now,
  running: [],
  blocked: [],
  blockedBy: {},
  landmarks: [],
  results: [],
  stage: 'searching',
  citations: [],
  summary: '',
  summaryStatus: 'idle',
});

const add = (list: SourceId[], id: SourceId) => (list.includes(id) ? list : [...list, id]);
const remove = (list: SourceId[], id: SourceId) => list.filter((existing) => existing !== id);
const withoutBlock = (by: SearchState['blockedBy'], id: SourceId) => Object.fromEntries(Object.entries(by).filter(([source]) => source !== id)) as SearchState['blockedBy'];
const settled = (s: SearchState, id: SourceId) => ({ running: remove(s.running, id), blocked: remove(s.blocked, id), blockedBy: withoutBlock(s.blockedBy, id) });

/** The first source blocked for `reason`, for the page's one action per kind. */
export const firstBlocked = (s: Pick<SearchState, 'blocked' | 'blockedBy'>, reason: BlockReason): SourceId | undefined => s.blocked.find((id) => s.blockedBy[id] === reason);

export function reduce(s: SearchState, e: PipelineEvent, now = Date.now()): SearchState {
  switch (e.type) {
    case 'source_start':
      return { ...s, running: add(s.running, e.source) };
    case 'source_blocked':
      return { ...s, running: remove(s.running, e.source), blocked: add(s.blocked, e.source), blockedBy: { ...s.blockedBy, [e.source]: e.reason } };
    case 'source_done':
    case 'source_error':
      return { ...s, ...settled(s, e.source) };
    case 'late_results':
      return { ...s, ...settled(s, e.source), results: e.results };
    case 'fused':
      return { ...s, results: e.results, stage: e.partial ? 'searching' : 'refining' };
    case 'reranked':
      return { ...s, results: e.results };
    case 'routed':
      return { ...s, ...(e.suggest ? { suggest: e.suggest } : {}), intentError: e.error };
    case 'academic_plan':
      return { ...s, plan: e.plan, landmarks: e.landmarks, planError: e.error };
    case 'judged':
      return { ...s, results: e.results, judgeError: e.error };
    case 'summary_start':
      return { ...s, citations: e.citations, summaryStatus: 'loading' };
    case 'summary_prompt':
      return { ...s, citations: e.citations, summaryStatus: 'starting' };
    case 'summary_delta':
      return { ...s, summary: s.summary + e.text, summaryStatus: 'streaming' };
    case 'summary_done':
      return { ...s, summaryStatus: 'done' };
    case 'summary_error':
      return { ...s, summaryStatus: 'error', summaryError: e.error };
    case 'done':
      return { ...s, stage: 'done', finishedAt: now, results: s.results.length ? s.results : e.result.results };
  }
}

/** Sources that may still report after `done` (blocked, or past the soft deadline). */
export function lateSourcesAfterDone(e: PipelineEvent): SourceId[] {
  return e.type === 'done' ? e.result.sourceStats.filter((stat) => stat.status === 'late').map((stat) => stat.source) : [];
}
