import type { AcademicPlan, BlockReason, Citation, FusedResult, IntentSuggestion, NewsSearchInfo, PipelineEvent, PipelineResult, SearchMode, SourceId, VerifiedLandmark } from '@kiwi-search/core';
import { newsEvidence } from './news';

export type SummaryStatus = 'idle' | 'loading' | 'starting' | 'streaming' | 'done' | 'error' | 'stopped';

export interface SearchState {
  query: string;
  mode: SearchMode;
  startedAt: number;
  outcome: 'active' | 'complete' | 'stopped' | 'interrupted';
  interruption?: string;
  sourceStats: PipelineResult['sourceStats'];
  sourceErrors: Partial<Record<SourceId, string>>;
  readiness?: { enabled: number; ready: number };
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
  /** Selected, checked evidence in citation order, preserved for a summary-only retry. */
  summaryResults: FusedResult[];
  summaryAt?: string;
  news?: NewsSearchInfo;
  summaryStale: boolean;
  /** The article evidence when citations were chosen, including the period while the overview streams. */
  summaryEvidence?: string;
  /** Which overview is on screen: the early one (from the first results), the early one kept after checking, or the final one. */
  summaryPhase?: 'preliminary' | 'kept' | 'final';
  /** The final overview being written while the early one stays on screen; it replaces the early one once complete. */
  summaryUpdate?: SummaryUpdate;
  /** Why the final overview could not replace the early one, which stays. */
  summaryUpdateError?: string;
  fatal?: string;
}

export interface SummaryUpdate {
  citations: Citation[];
  text: string;
  /** Its evidence in citation order, for a retry once it is on screen. */
  results: FusedResult[];
  summaryAt?: string;
  evidence?: string;
}

export const emptyState = (query: string, mode: SearchMode, now = Date.now()): SearchState => ({
  query,
  mode,
  startedAt: now,
  outcome: 'active',
  sourceStats: [],
  sourceErrors: {},
  running: [],
  blocked: [],
  blockedBy: {},
  landmarks: [],
  results: [],
  stage: 'searching',
  citations: [],
  summary: '',
  summaryResults: [],
  summaryStatus: 'idle',
  summaryStale: false,
});

const add = (list: SourceId[], id: SourceId) => (list.includes(id) ? list : [...list, id]);
const remove = (list: SourceId[], id: SourceId) => list.filter((existing) => existing !== id);
const withoutBlock = (by: SearchState['blockedBy'], id: SourceId) => Object.fromEntries(Object.entries(by).filter(([source]) => source !== id)) as SearchState['blockedBy'];
const settled = (s: SearchState, id: SourceId) => ({ running: remove(s.running, id), blocked: remove(s.blocked, id), blockedBy: withoutBlock(s.blockedBy, id) });
const stat = (s: SearchState, next: PipelineResult['sourceStats'][number]) => [...s.sourceStats.filter((item) => item.source !== next.source), next];
const staleFor = (s: SearchState, results: FusedResult[]) => s.summaryStale || (s.mode === 'news' && s.summaryEvidence !== undefined && newsEvidence(results) !== s.summaryEvidence);

export const summaryBusy = (status: SummaryStatus) => status === 'loading' || status === 'starting' || status === 'streaming';
/** An overview is being written, on screen or behind the early one. */
export const summaryWorking = (s: Pick<SearchState, 'summaryStatus' | 'summaryUpdate'>) => summaryBusy(s.summaryStatus) || !!s.summaryUpdate;
/** The early overview is on screen with text, so a final one is written behind it instead of clearing it. */
const showsEarly = (s: SearchState) => s.summaryPhase === 'preliminary' && !!s.summary && s.summaryStatus !== 'error' && s.summaryStatus !== 'stopped';
const citedExcerpts = (s: SearchState, citations: Citation[]) => structuredClone(citations.flatMap((cite) => {
  const result = s.results.find((r) => r.url === cite.url);
  if (!result) return [];
  const { content: _content, ...excerpt } = result;
  return [excerpt];
}));

/** Stop waiting without discarding evidence already delivered. */
export function endSession(s: SearchState, outcome: 'stopped' | 'interrupted', interruption?: string, now = Date.now()): SearchState {
  return { ...s, outcome, interruption, stage: 'done', finishedAt: s.finishedAt ?? now, running: [], blocked: [], blockedBy: {},
    summaryStatus: summaryBusy(s.summaryStatus) ? 'stopped' : s.summaryStatus, summaryUpdate: undefined };
}

export function restoreSnapshot(s: SearchState): SearchState {
  const snapshot = structuredClone(s);
  return snapshot.outcome === 'active' || snapshot.running.length || snapshot.blocked.length || summaryWorking(snapshot)
    ? endSession(snapshot, 'stopped') : snapshot;
}

/** The first source blocked for `reason`, for the page's one action per kind. */
export const firstBlocked = (s: Pick<SearchState, 'blocked' | 'blockedBy'>, reason: BlockReason): SourceId | undefined => s.blocked.find((id) => s.blockedBy[id] === reason);

export function reduce(s: SearchState, e: PipelineEvent, now = Date.now()): SearchState {
  if (s.summaryUpdate && 'phase' in e) return e.phase === 'final' ? reduceUpdate(s, s.summaryUpdate, e) : s;
  switch (e.type) {
    case 'source_start':
      return { ...s, running: add(s.running, e.source), sourceErrors: Object.fromEntries(Object.entries(s.sourceErrors).filter(([id]) => id !== e.source)) };
    case 'source_blocked':
      return { ...s, running: remove(s.running, e.source), blocked: add(s.blocked, e.source), blockedBy: { ...s.blockedBy, [e.source]: e.reason },
        sourceStats: stat(s, { source: e.source, count: 0, ms: now - s.startedAt, status: 'blocked', blockedReason: e.reason }) };
    case 'source_done':
      return { ...s, ...settled(s, e.source), sourceStats: stat(s, { source: e.source, count: e.count, ms: e.ms }) };
    case 'source_error':
      return { ...s, ...settled(s, e.source), sourceErrors: { ...s.sourceErrors, [e.source]: e.error }, sourceStats: stat(s, { source: e.source, count: 0, ms: e.ms, error: e.error }) };
    case 'late_results':
      return {
        ...s, ...settled(s, e.source), results: e.results,
        // A preceding source_done carries raw result count and exact source duration; fusion is not that count.
        sourceStats: s.sourceStats.some((item) => item.source === e.source && !item.status && !item.error) ? s.sourceStats
          : stat(s, { source: e.source, count: e.results.filter((r) => r.sources.some((source) => source.source === e.source)).length, ms: now - s.startedAt }),
        summaryStale: staleFor(s, e.results),
      };
    case 'fused':
      return { ...s, results: e.results, stage: e.partial ? 'searching' : 'refining', summaryStale: staleFor(s, e.results) };
    case 'reranked':
      return { ...s, results: e.results, summaryStale: staleFor(s, e.results) };
    case 'routed':
      return { ...s, ...(e.suggest ? { suggest: e.suggest } : {}), intentError: e.error };
    case 'academic_plan':
      return { ...s, plan: e.plan, landmarks: e.landmarks, planError: e.error };
    case 'judged':
      return { ...s, results: e.results, judgeError: e.error, summaryStale: staleFor(s, e.results) };
    case 'summary_start':
      if (e.phase === 'final' && showsEarly(s)) {
        return { ...s, summaryStatus: summaryBusy(s.summaryStatus) ? 'done' : s.summaryStatus, summaryUpdateError: undefined,
          summaryUpdate: { citations: e.citations, text: '', results: citedExcerpts(s, e.citations), evidence: s.mode === 'news' ? newsEvidence(s.results) : undefined } };
      }
      return { ...s, citations: e.citations, summary: '', summaryError: undefined, summaryResults: citedExcerpts(s, e.citations), summaryStatus: 'loading', summaryStale: false,
        summaryEvidence: s.mode === 'news' ? newsEvidence(s.results) : undefined, summaryPhase: e.phase, summaryUpdate: undefined, summaryUpdateError: undefined };
    case 'summary_prompt':
      return { ...s, citations: e.citations, summaryStatus: 'starting', summaryEvidence: s.mode === 'news' ? s.summaryEvidence ?? newsEvidence(s.results) : undefined };
    case 'summary_delta':
      return { ...s, summary: s.summary + e.text, summaryStatus: 'streaming' };
    case 'summary_done':
      return { ...s, summaryStatus: 'done' };
    case 'summary_stopped':
      return { ...s, summaryStatus: 'stopped' };
    case 'summary_error':
      return { ...s, summaryStatus: 'error', summaryError: e.error };
    case 'summary_checked':
      return e.keep && s.summaryPhase === 'preliminary' ? { ...s, summaryPhase: 'kept' } : s;
    case 'done':
      return { ...s, stage: 'done', outcome: 'complete', finishedAt: now, results: s.results.length ? s.results : e.result.results,
        news: e.result.news ? { ...e.result.news, ...(s.summaryAt ? { summaryAt: s.summaryAt } : {}) } : s.news,
        sourceStats: e.result.sourceStats, sourceErrors: { ...s.sourceErrors, ...Object.fromEntries(e.result.sourceStats.filter((item) => item.error).map((item) => [item.source, item.error!])) } };
    // The extension and the website are updated separately: an event added in a newer extension is not an error in an older page.
    default:
      return s;
  }
}

/** The final overview's events while the early one stays on screen: buffered, then swapped in whole so citation numbers never jump. */
function reduceUpdate(s: SearchState, u: SummaryUpdate, e: PipelineEvent): SearchState {
  switch (e.type) {
    case 'summary_prompt':
      return { ...s, summaryUpdate: { ...u, citations: e.citations } };
    case 'summary_delta':
      return { ...s, summaryUpdate: { ...u, text: u.text + e.text } };
    case 'summary_done':
      return { ...s, summary: u.text || e.text, citations: u.citations, summaryResults: u.results, summaryStatus: 'done', summaryError: undefined,
        summaryAt: u.summaryAt ?? s.summaryAt, news: u.summaryAt && s.news ? { ...s.news, summaryAt: u.summaryAt } : s.news,
        summaryEvidence: u.evidence, summaryStale: false, summaryPhase: 'final', summaryUpdate: undefined };
    case 'summary_error':
      return { ...s, summaryUpdate: undefined, summaryUpdateError: e.error };
    case 'summary_stopped':
      return { ...s, summaryUpdate: undefined };
    default:
      return s;
  }
}

/** Sources that may still report after `done` (blocked, or past the soft deadline). */
export function lateSourcesAfterDone(e: PipelineEvent): SourceId[] {
  return e.type === 'done' ? e.result.sourceStats.filter((stat) => stat.status === 'late').map((stat) => stat.source) : [];
}
