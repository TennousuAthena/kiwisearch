import type { FusedResult, PipelineEvent, PipelineResult } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import { emptyState, firstBlocked, lateSourcesAfterDone, reduce, type SearchState } from '../lib/searchState';

const result = (title: string, extra: Partial<FusedResult> = {}): FusedResult => ({
  key: title,
  url: `https://example.com/${title}`,
  title,
  snippet: '',
  sources: [],
  rrfScore: 1,
  score: 1,
  meta: {},
  ...extra,
});

function run(events: PipelineEvent[], start: SearchState = emptyState('q', 'web', 1000)): SearchState {
  return events.reduce((state, event) => reduce(state, event, 5000), start);
}

const done = (results: FusedResult[], sourceStats: PipelineResult['sourceStats'] = []): PipelineEvent => ({
  type: 'done',
  result: { query: 'q', mode: 'web', results, citations: [], sourceStats },
});

describe('search state reducer', () => {
  it('shows partial results while the search is still going, then moves on when fused is final', () => {
    const a = result('a');
    let state = run([{ type: 'source_start', source: 'google' }, { type: 'source_start', source: 'bing' }, { type: 'fused', results: [a], partial: true }]);
    expect(state.stage).toBe('searching');
    expect(state.results).toEqual([a]);
    expect(state.running).toEqual(['google', 'bing']);
    state = run([{ type: 'fused', results: [a, result('b')] }], state);
    expect(state.stage).toBe('refining');
  });

  it('tracks captcha-blocked sources until their results arrive, without keeping them as running', () => {
    let state = run([{ type: 'source_start', source: 'google' }, { type: 'source_blocked', source: 'google', message: 'captcha', reason: 'captcha' }]);
    expect(state.blocked).toEqual(['google']);
    expect(state.blockedBy).toEqual({ google: 'captcha' });
    expect(state.running).toEqual([]);
    state = run([{ type: 'late_results', source: 'google', results: [result('late')] }], state);
    expect(state.blocked).toEqual([]);
    expect(state.blockedBy).toEqual({});
    expect(state.results.map((r) => r.title)).toEqual(['late']);
  });

  it('keeps a login wall apart from a captcha, one action each', () => {
    const state = run([
      { type: 'source_blocked', source: 'zhihu', message: '登录', reason: 'login' },
      { type: 'source_blocked', source: 'google', message: '验证', reason: 'captcha' },
      { type: 'source_blocked', source: 'x', message: '登录', reason: 'login' },
    ]);
    expect(firstBlocked(state, 'login')).toBe('zhihu');
    expect(firstBlocked(state, 'captcha')).toBe('google');
    expect(firstBlocked(emptyState('q', 'web'), 'login')).toBeUndefined();
  });

  it('remembers that the decision model could not say what else to search, and forgets it when it can', () => {
    let state = run([{ type: 'routed', routes: [], scores: {}, error: 'HTTP 451: nope' }]);
    expect(state.intentError).toBe('HTTP 451: nope');
    state = run([{ type: 'routed', routes: ['zhihu'], scores: { zhihu: 0.9 } }], state);
    expect(state.intentError).toBeUndefined();
  });

  it('clears a blocked source that fails', () => {
    const state = run([{ type: 'source_blocked', source: 'bing', message: 'x', reason: 'captcha' }, { type: 'source_error', source: 'bing', error: 'timeout', ms: 1 }]);
    expect(state.blocked).toEqual([]);
  });

  it('keeps judged results with hidden flags and remembers a judge failure', () => {
    const hidden = result('farm', { hidden: { reason: 'junk' } });
    const state = run([{ type: 'judged', results: [result('good'), hidden], error: '超过 6000ms' }]);
    expect(state.results).toHaveLength(2);
    expect(state.judgeError).toBe('超过 6000ms');
  });

  it('streams the summary and records its end state', () => {
    const state = run([
      { type: 'summary_start', citations: [{ n: 1, url: 'https://example.com/a', title: 'a' }] },
      { type: 'summary_delta', text: 'Hel' },
      { type: 'summary_delta', text: 'lo' },
    ]);
    expect(state.summary).toBe('Hello');
    expect(state.summaryStatus).toBe('streaming');
    expect(run([{ type: 'summary_done', text: 'Hello' }], state).summaryStatus).toBe('done');
    expect(run([{ type: 'summary_error', error: 'boom' }], state)).toMatchObject({ summaryStatus: 'error', summaryError: 'boom' });
  });

  it('stamps the finish time and falls back to the final result list', () => {
    const state = run([done([result('only')])]);
    expect(state).toMatchObject({ stage: 'done', finishedAt: 5000 });
    expect(state.results.map((r) => r.title)).toEqual(['only']);
    expect(run([{ type: 'fused', results: [result('x')] }, done([result('y')])]).results.map((r) => r.title)).toEqual(['x']);
  });

  it('reports sources that are still running past the soft deadline', () => {
    const event = done([], [{ source: 'bing', count: 0, ms: 6000, status: 'late' }, { source: 'google', count: 3, ms: 1000 }, { source: 'baidu', count: 0, ms: 1, status: 'blocked' }]);
    expect(lateSourcesAfterDone(event)).toEqual(['bing']);
    expect(lateSourcesAfterDone({ type: 'source_start', source: 'google' })).toEqual([]);
  });
});
