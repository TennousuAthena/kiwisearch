import { describe, expect, it } from 'vitest';
import { emptyReason } from '../src/lib/searchFeedback';
import { emptyState } from '../src/lib/searchState';

describe('actionable empty results', () => {
  it('distinguishes missing sources, failures, genuine no match and login', () => {
    const state = { ...emptyState('test', 'web'), stage: 'done' as const, outcome: 'complete' as const };
    expect(emptyReason({ ...state, readiness: { enabled: 0, ready: 0 } }, false, 0)).toBe('noSources');
    expect(emptyReason({ ...state, readiness: { enabled: 1, ready: 0 } }, false, 0)).toBe('noSources');
    expect(emptyReason({ ...state, sourceStats: [{ source: 'bing', count: 0, ms: 100, error: 'offline' }] }, false, 0)).toBe('failed');
    expect(emptyReason({ ...state, sourceStats: [{ source: 'bing', count: 0, ms: 100 }] }, false, 0)).toBe('noMatch');
    expect(emptyReason({ ...state, blocked: ['bing'] }, false, 0)).toBe('waiting');
  });
  it('does not misrepresent a stopped or hidden search as no match', () => {
    const state = emptyState('test', 'web');
    expect(emptyReason({ ...state, outcome: 'interrupted' }, true, 2)).toBe('interrupted');
    expect(emptyReason({ ...state, outcome: 'stopped' }, false, 0)).toBe('interrupted');
    expect(emptyReason(state, false, 2)).toBe('hidden');
  });
  it('does not let an active filter disguise source failure', () => {
    const state = emptyState('test', 'academic');
    state.sourceStats = [{ source: 'openalex', count: 0, ms: 20, error: 'offline' }];
    expect(emptyReason(state, true, 0)).toBe('failed');
  });
});
