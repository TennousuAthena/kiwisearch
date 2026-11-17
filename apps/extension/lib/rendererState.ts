import type { SourceId } from '@kiwi-search/core';

export interface RendererState {
  windowId: number;
  /** v1 used auto-saved browser groups. Never reclaim that legacy state. */
  version: 2;
  tabs: Partial<Record<SourceId, number>>;
  lastUsed: number;
  lastUsedByEngine: Partial<Record<SourceId, number>>;
}

/** The page the browser shows when a navigation failed (no network, connection refused, the site answered 403 …). No content script runs there. */
export function isBrowserErrorPage(url: string | undefined): boolean {
  return !!url && url.startsWith('chrome-error://');
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

/** Session IDs establish ownership only for this format; legacy groups and malformed state stay untouched. */
export function parseRendererState(value: unknown): RendererState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<RendererState>;
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const id = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (state.version !== 2 || 'groupId' in state || !id(state.windowId) || !timestamp(state.lastUsed) ||
      !record(state.tabs) || !Object.values(state.tabs).every(id) ||
      !record(state.lastUsedByEngine) || !Object.values(state.lastUsedByEngine).every(timestamp)) return null;
  return state as RendererState;
}

export function workerIdentity(engine: SourceId, requestId: string): { engine: SourceId; requestId: string } {
  return { engine, requestId };
}
