import type { Citation, FusedResult, PipelineEvent, SearchMode, SourceId } from '@kiwi-search/core';

export type SummaryStatus = 'idle' | 'loading' | 'starting' | 'streaming' | 'done' | 'error';

export interface SearchState {
  query: string;
  mode: SearchMode;
  startedAt: number;
  finishedAt?: number;
  /** Sources still running. Only used to tell whether more results may arrive; never shown by name. */
  running: SourceId[];
  /** Sources waiting on a captcha; the page offers one "verify" action for the first of them. */
  blocked: SourceId[];
  results: FusedResult[];
  stage: 'searching' | 'refining' | 'done';
  /** Set when the decision model failed or timed out; results fall back to the plain fused order. */
  judgeError?: string;
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
  results: [],
  stage: 'searching',
  citations: [],
  summary: '',
  summaryStatus: 'idle',
});

const add = (list: SourceId[], id: SourceId) => (list.includes(id) ? list : [...list, id]);
const remove = (list: SourceId[], id: SourceId) => list.filter((existing) => existing !== id);
const settled = (s: SearchState, id: SourceId) => ({ running: remove(s.running, id), blocked: remove(s.blocked, id) });

export function reduce(s: SearchState, e: PipelineEvent, now = Date.now()): SearchState {
  switch (e.type) {
    case 'source_start':
      return { ...s, running: add(s.running, e.source) };
    case 'source_blocked':
      return { ...s, running: remove(s.running, e.source), blocked: add(s.blocked, e.source) };
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
      return s;
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
