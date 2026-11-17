import { describe, expect, it } from 'vitest';
import { isBrowserErrorPage, parseRendererState, workerIdentity } from '../lib/rendererState';

describe('renderer state', () => {
  const state = { version: 2, windowId: 1, tabs: { google: 2 }, lastUsed: 0, lastUsedByEngine: { google: 0 } };
  it('accepts the ungrouped session format', () => { expect(parseRendererState(state)).toEqual(state); });
  it.each([undefined, null, {}, { ...state, version: 1 }, { ...state, groupId: 10 },
    { ...state, tabs: null }, { ...state, tabs: { google: '2' } },
    { ...state, windowId: -1 }, { ...state, lastUsed: NaN }, { ...state, lastUsedByEngine: [] }])(
    'rejects legacy or malformed state: %j', (value) => { expect(parseRendererState(value)).toBeNull(); },
  );
  it('returns the engine ID in the worker handshake identity', () => {
    expect(workerIdentity('google', 'request-1')).toEqual({ engine: 'google', requestId: 'request-1' });
  });
  it('recognizes browser error pages', () => {
    expect(isBrowserErrorPage('chrome-error://chromewebdata/')).toBe(true);
    expect(isBrowserErrorPage('https://x.com/search?q=1')).toBe(false);
    expect(isBrowserErrorPage(undefined)).toBe(false);
  });
});
