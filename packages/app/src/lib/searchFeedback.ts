import type { SearchState } from './searchState';

export type EmptyReason = 'interrupted' | 'waiting' | 'noSources' | 'failed' | 'filtered' | 'hidden' | 'noMatch';
export function emptyReason(state: SearchState, filtered: boolean, hiddenCount: number): EmptyReason {
  if (state.outcome === 'interrupted' || state.outcome === 'stopped') return 'interrupted';
  if (state.blocked.length) return 'waiting';
  if (state.readiness?.ready === 0) return 'noSources';
  if (state.sourceStats.length && state.sourceStats.every((stat) => !!stat.error && stat.count === 0)) return 'failed';
  if (filtered && state.results.some((result) => !result.hidden)) return 'filtered';
  if (hiddenCount) return 'hidden';
  return 'noMatch';
}
