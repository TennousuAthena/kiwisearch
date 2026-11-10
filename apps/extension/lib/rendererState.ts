import type { SourceId } from '@fusion-search/core';

export interface RendererState {
  windowId: number;
  groupId: number;
  tabs: Partial<Record<SourceId, number>>;
  lastUsed: number;
  lastUsedByEngine: Partial<Record<SourceId, number>>;
}

export function createAsyncLock() {
  let tail: Promise<void> = Promise.resolve();
  return async function withLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };
}

export function mergeRendererState(current: RendererState, incoming: RendererState): RendererState {
  if (current === incoming) return current;
  if (current.windowId !== incoming.windowId || current.groupId !== incoming.groupId) return incoming;
  const tabs = { ...current.tabs, ...incoming.tabs };
  const lastUsedByEngine = { ...current.lastUsedByEngine, ...incoming.lastUsedByEngine };
  Object.assign(current, incoming, {
    tabs,
    lastUsedByEngine,
    lastUsed: Math.max(current.lastUsed, incoming.lastUsed),
  });
  return current;
}

export function workerIdentity(engine: SourceId, requestId: string): { engine: SourceId; requestId: string } {
  return { engine, requestId };
}
