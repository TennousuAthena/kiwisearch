import { describe, expect, it } from 'vitest';
import { createAsyncLock, mergeRendererState, workerIdentity, type RendererState } from '../lib/rendererState';
import type { SourceId } from '@kiwi-search/core';

const engines: SourceId[] = ['google', 'bing', 'baidu', 'duckduckgo', 'scholar'];

function initialState(): RendererState {
  return {
    windowId: 1,
    groupId: 10,
    tabs: {},
    lastUsed: 0,
    lastUsedByEngine: {},
  };
}

describe('renderer state helpers', () => {
  it('serializes concurrent initialization and merges tabs for five engines', async () => {
    const withLock = createAsyncLock();
    let state: RendererState | undefined;
    let groupsCreated = 0;
    let nextTabId = 0;

    await Promise.all(
      engines.map(async (engine) => {
        await withLock(async () => {
          if (!state) {
            groupsCreated++;
            await Promise.resolve();
            state = initialState();
          }
        });

        await Promise.resolve();
        await withLock(async () => {
          const current = state!;
          const now = Date.now();
          const incoming: RendererState = {
            ...current,
            tabs: { [engine]: ++nextTabId },
            lastUsed: now,
            lastUsedByEngine: { [engine]: now },
          };
          state = mergeRendererState(current, incoming);
        });
      }),
    );

    expect(groupsCreated).toBe(1);
    expect(state).toBeDefined();
    expect(Object.keys(state!.tabs).sort()).toEqual([...engines].sort());
    expect(new Set(Object.values(state!.tabs)).size).toBe(5);
    expect(Object.keys(state!.lastUsedByEngine).sort()).toEqual([...engines].sort());
  });

  it('returns the engine ID string in the worker handshake identity', () => {
    expect(workerIdentity('google', 'request-1')).toEqual({ engine: 'google', requestId: 'request-1' });
  });
});
