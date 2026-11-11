import type { BlockReason, BrowserEngine, BrowserRunOptions, SearchHit, SearchMode, SourceId } from '@kiwi-search/core';
import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import { createAsyncLock, mergeRendererState, workerIdentity, type RendererState } from './rendererState';
import { loadConfig } from './settings';

interface PendingRequest {
  requestId: string;
  engine: BrowserEngine;
  tabId: number;
  count: number;
  mode: SearchMode;
  focusOnCaptcha: boolean;
  resolve: (hits: SearchHit[]) => void;
  reject: (error: Error) => void;
  onBlocked: (message: string, reason?: BlockReason) => void;
  restoreWindowId?: number;
  focusedForCaptcha: boolean;
  cleanup: () => void;
}

const STORAGE_KEY = 'kiwiRenderer';
const GROUP_TITLE = 'Kiwi Search';
const withStateLock = createAsyncLock();
let cachedState: RendererState | undefined;
let statePromise: Promise<RendererState | null> | undefined;
const pendingById = new Map<string, PendingRequest>();
const pendingByTab = new Map<number, PendingRequest>();
const queues = new Map<SourceId, Promise<unknown>>();
const lastStarted = new Map<SourceId, number>();

async function readState(): Promise<RendererState | null> {
  if (cachedState) return cachedState;
  statePromise ??= browser.storage.session.get(STORAGE_KEY).then(({ [STORAGE_KEY]: saved }) => {
    cachedState = saved as RendererState | undefined;
    return cachedState ?? null;
  });
  try {
    return await statePromise;
  } finally {
    statePromise = undefined;
  }
}

async function saveState(state: RendererState): Promise<void> {
  if (
    cachedState &&
    cachedState !== state &&
    cachedState.windowId === state.windowId &&
    cachedState.groupId === state.groupId
  ) {
    state = mergeRendererState(cachedState, state);
  }
  cachedState = state;
  await browser.storage.session.set({ [STORAGE_KEY]: state });
}

/** A window of its own, minimized, so search pages never show up in the window the user is working in. */
async function createWorkerWindow(): Promise<{ id: number; initialTabId?: number }> {
  const created = await browser.windows.create({ url: 'about:blank', type: 'normal', state: 'minimized', focused: false });
  if (created?.id === undefined) throw new Error('Unable to create a window for search workers');
  // `state: 'minimized'` is ignored at creation on some platforms (macOS Chromium reports `normal`), so ask again once the window exists.
  await browser.windows.update(created.id, { state: 'minimized' }).catch(() => {});
  const [tab] = await browser.tabs.query({ windowId: created.id });
  return { id: created.id, initialTabId: tab?.id };
}

/**
 * Put tabs into the worker group (a new one in `windowId` without `groupId`), titled so it is recognizable if the window is ever brought forward.
 * A new group is created in the *current* window unless `createProperties.windowId` says otherwise, which would pull the tabs into the user's window.
 */
async function groupWorkerTabs(tabIds: [number, ...number[]], windowId: number, groupId?: number): Promise<number> {
  const id = await browser.tabs.group(groupId === undefined ? { tabIds, createProperties: { windowId } } : { tabIds, groupId });
  await browser.tabGroups.update(id, { title: GROUP_TITLE, color: 'grey' });
  return id;
}

async function validState(state: RendererState | null): Promise<RendererState | null> {
  if (!state) return null;
  let window: Browser.windows.Window;
  try {
    window = await browser.windows.get(state.windowId);
  } catch {
    return null;
  }
  if (window.incognito || window.type !== 'normal') return null;
  try {
    const group = await browser.tabGroups.get(state.groupId);
    if (group.windowId !== state.windowId) return null;
  } catch {
    // The group is gone (the user ungrouped its tabs): group the worker tabs that are still in the window again.
    const remaining: number[] = [];
    for (const tabId of Object.values(state.tabs)) {
      if (tabId === undefined) continue;
      try {
        const tab = await browser.tabs.get(tabId);
        if (tab.windowId === state.windowId && tab.groupId === -1) remaining.push(tabId);
      } catch {
        // The tab was closed with its window.
      }
    }
    if (!remaining.length) return null;
    state.groupId = await groupWorkerTabs(remaining as [number, ...number[]], state.windowId);
    await saveState(state);
  }
  for (const [id, tabId] of Object.entries(state.tabs) as [SourceId, number][]) {
    try {
      const tab = await browser.tabs.get(tabId);
      // A tab the user dragged out of the worker window or its group is theirs now.
      if (tab.windowId !== state.windowId || tab.groupId !== state.groupId) delete state.tabs[id];
    } catch {
      delete state.tabs[id];
    }
  }
  return state;
}

async function ensureState(engineId: SourceId): Promise<RendererState> {
  const existing = await validState(await readState());
  if (existing) return existing;
  const { id: windowId, initialTabId } = await createWorkerWindow();
  const tabId = initialTabId ?? (await browser.tabs.create({ windowId, url: 'about:blank', active: false })).id;
  if (tabId === undefined) throw new Error('Unable to create a worker tab');
  const groupId = await groupWorkerTabs([tabId], windowId);
  await browser.tabs.update(tabId, { muted: true, autoDiscardable: false });
  const state: RendererState = {
    windowId,
    groupId,
    tabs: { [engineId]: tabId },
    lastUsed: Date.now(),
    lastUsedByEngine: {},
  };
  await saveState(state);
  return state;
}

async function ensureWorkerTab(state: RendererState, engineId: SourceId): Promise<number> {
  const existingId = state.tabs[engineId];
  if (existingId !== undefined) {
    try {
      const tab = await browser.tabs.get(existingId);
      if (tab.windowId === state.windowId && tab.groupId === state.groupId) return existingId;
    } catch {
      // Recreate a worker tab that the user or browser closed.
    }
    delete state.tabs[engineId];
  }
  const tab = await browser.tabs.create({ windowId: state.windowId, url: 'about:blank', active: false });
  if (tab.id === undefined) throw new Error(`Unable to create ${engineId} worker tab`);
  await groupWorkerTabs([tab.id], state.windowId, state.groupId);
  await browser.tabs.update(tab.id, { muted: true, autoDiscardable: false });
  state.tabs[engineId] = tab.id;
  await saveState(state);
  return tab.id;
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('Search cancelled');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Search cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener(
      'abort',
      onAbort,
      { once: true },
    );
  });
}

function enqueue<T>(engineId: SourceId, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(engineId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(engineId, next);
  void next.finally(() => {
    if (queues.get(engineId) === next) queues.delete(engineId);
  }).catch(() => {});
  return next;
}

/** Put the worker window back out of the way once a verification is done, and hand focus back to where the user was. */
async function hideWorker(windowId: number, restoreWindowId?: number): Promise<void> {
  try {
    await browser.windows.update(windowId, { state: 'minimized' });
    if (restoreWindowId !== undefined) await browser.windows.update(restoreWindowId, { focused: true });
  } catch {
    // The worker window or the original window may have been closed.
  }
}

async function restoreAfterCaptcha(request: PendingRequest): Promise<void> {
  const state = await readState();
  if (state) await hideWorker(state.windowId, request.restoreWindowId);
}

/** Bring the worker window up so the user can finish a verification. Only when asked for, or when the user opted in. */
async function focusForCaptcha(
  request: PendingRequest,
  state: RendererState,
  focusOnCaptcha: boolean,
  force = false,
): Promise<void> {
  if (!force && (!focusOnCaptcha || request.focusedForCaptcha)) return;
  try {
    const previous = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
    request.restoreWindowId = previous.id !== undefined && previous.id !== state.windowId && !previous.incognito ? previous.id : undefined;
    await browser.windows.update(state.windowId, { state: 'normal', focused: true });
    await browser.tabs.update(request.tabId, { active: true });
    request.focusedForCaptcha = true;
  } catch {
    // Keep the request alive; the user can open the worker window manually.
  }
}

export function runBrowserEngine(engine: BrowserEngine, query: string, opts: BrowserRunOptions): Promise<SearchHit[]> {
  return enqueue(engine.id, async () => {
    const last = await withStateLock(async () => {
      const state = await ensureState(engine.id);
      return lastStarted.get(engine.id) ?? state.lastUsedByEngine[engine.id] ?? 0;
    });
    const waitFor = Math.max(opts.renderer.minIntervalMs, engine.minIntervalMs ?? 0) - (Date.now() - last);
    if (waitFor > 0) await pause(waitFor, opts.signal);
    if (opts.signal.aborted) throw opts.signal.reason ?? new Error('Search cancelled');
    const tabId = await withStateLock(async () => {
      if (opts.signal.aborted) throw opts.signal.reason ?? new Error('Search cancelled');
      const currentState = await ensureState(engine.id);
      const tabId = await ensureWorkerTab(currentState, engine.id);
      if (opts.signal.aborted) throw opts.signal.reason ?? new Error('Search cancelled');
      const now = Date.now();
      lastStarted.set(engine.id, now);
      currentState.lastUsed = now;
      currentState.lastUsedByEngine[engine.id] = now;
      await saveState(currentState);
      return tabId;
    });
    // Queueing and rate limiting are over; the pipeline's per-source timeout runs from here.
    opts.onStart();
    const requestId = crypto.randomUUID();
    return new Promise<SearchHit[]>((resolve, reject) => {
      const cleanup = () => {
        pendingById.delete(requestId);
        pendingByTab.delete(tabId);
      };
      const onAbort = () => {
        cleanup();
        reject(opts.signal.reason ?? new Error('Search cancelled'));
      };
      const pending: PendingRequest = {
        requestId,
        engine,
        tabId,
        count: opts.count,
        mode: opts.mode,
        focusOnCaptcha: opts.renderer.focusOnCaptcha,
        resolve,
        reject,
        onBlocked: opts.onBlocked,
        focusedForCaptcha: false,
        cleanup: () => opts.signal.removeEventListener('abort', onAbort),
      };
      pendingById.set(requestId, pending);
      pendingByTab.set(tabId, pending);
      opts.signal.addEventListener('abort', onAbort, { once: true });
      void browser.tabs
        .update(tabId, { url: engine.buildUrl(query, opts.count, opts.mode), active: false, muted: true, autoDiscardable: false })
        .catch((error) => {
          cleanup();
          pending.cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  });
}

export function workerForTab(
  tabId: number | undefined,
): { engine: SourceId; requestId: string; count: number; mode: SearchMode } | null {
  if (tabId === undefined) return null;
  const request = pendingByTab.get(tabId);
  return request
    ? { ...workerIdentity(request.engine.id, request.requestId), count: request.count, mode: request.mode }
    : null;
}

export async function handleWorkerMessage(message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> {
  const msg = message as { type?: string; requestId?: string; source?: string; reason?: BlockReason; hits?: Omit<SearchHit, 'source'>[] };
  const tabId = sender.tab?.id;
  if (msg?.type === 'kiwi:worker?') {
    const pending = workerForTab(tabId);
    return pending ? { type: 'kiwi:worker!', ...pending } : { type: 'kiwi:not-worker' };
  }
  if (msg?.type === 'kiwi:blocked' && tabId !== undefined) {
    const request = pendingById.get(msg.requestId ?? '');
    if (request && request.tabId === tabId) {
      const state = await withStateLock(() => readState());
      const reason: BlockReason = msg.reason === 'login' ? 'login' : 'captcha';
      request.onBlocked(reason === 'login' ? '需要在这个浏览器里登录' : '需要在搜索引擎页面手动完成验证', reason);
      // Only a captcha may bring the window forward by itself; a login wall waits for the user to ask.
      if (state) await focusForCaptcha(request, state, request.focusOnCaptcha && reason === 'captcha');
    }
    return { ok: true };
  }
  if (msg?.type === 'kiwi:extracted' && tabId !== undefined) {
    const request = pendingById.get(msg.requestId ?? '');
    if (request && request.tabId === tabId) {
      pendingById.delete(request.requestId);
      pendingByTab.delete(tabId);
      request.cleanup();
      const hits = (msg.hits ?? []).map((hit, index) => ({ ...hit, source: request.engine.id, rank: index + 1 })) as SearchHit[];
      request.resolve(hits);
      if (request.focusedForCaptcha) void restoreAfterCaptcha(request);
    }
    return { ok: true };
  }
  if (msg?.type === 'kiwi:focus-worker' && typeof msg.source === 'string') {
    const state = await withStateLock(async () => validState(await readState()));
    const tabId = state?.tabs[msg.source as SourceId];
    if (state && tabId !== undefined) {
      const request = pendingByTab.get(tabId);
      if (request) {
        await focusForCaptcha(request, state, false, true);
      } else {
        await browser.windows.update(state.windowId, { state: 'normal', focused: true });
        await browser.tabs.update(tabId, { active: true });
      }
    }
    return { ok: !!tabId };
  }
  return undefined;
}

export async function collectIdleWorkers(): Promise<void> {
  const config = await loadConfig();
  await withStateLock(async () => {
    const state = await validState(await readState());
    if (!state) return;
    const maxIdle = config.renderer.workerIdleMinutes * 60_000;
    const now = Date.now();
    for (const [source, tabId] of Object.entries(state.tabs) as [SourceId, number][]) {
      if (pendingByTab.has(tabId)) continue;
      if (now - (state.lastUsedByEngine[source] ?? state.lastUsed) < maxIdle) continue;
      try {
        await browser.tabs.remove(tabId);
      } catch {
        // Already closed.
      }
      delete state.tabs[source];
      delete state.lastUsedByEngine[source];
    }
    state.lastUsed = now;
    await saveState(state);
  });
}

export function forgetWorkerTab(tabId: number): void {
  const pending = pendingByTab.get(tabId);
  if (pending) {
    pendingByTab.delete(tabId);
    pendingById.delete(pending.requestId);
    pending.cleanup();
    pending.reject(new Error('Search worker tab was closed'));
  }
  void withStateLock(async () => {
    const state = await readState();
    if (!state) return;
    for (const [id, workerTab] of Object.entries(state.tabs) as [SourceId, number][]) {
      if (workerTab === tabId) delete state.tabs[id];
    }
    await saveState(state);
  }).catch(() => {});
}
