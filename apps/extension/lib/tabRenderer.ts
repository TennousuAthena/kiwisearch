import type { BrowserEngine, SearchHit, SourceId } from '@kiwi-search/core';
import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import { createAsyncLock, mergeRendererState, workerIdentity, type RendererState } from './rendererState';
import { loadConfig } from './settings';

interface PendingRequest {
  requestId: string;
  engine: BrowserEngine;
  tabId: number;
  resolve: (hits: SearchHit[]) => void;
  reject: (error: Error) => void;
  onBlocked: (message: string) => void;
  restoreTabId?: number;
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

async function normalWindow(): Promise<{ id: number; initialTabId?: number }> {
  try {
    const focused = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
    if (focused.id !== undefined && focused.type === 'normal' && !focused.incognito) return { id: focused.id };
  } catch {
    // The browser may not have a focused normal window.
  }
  const windows = await browser.windows.getAll({ populate: false });
  const normal = windows.find((window) => window.id !== undefined && window.type === 'normal' && !window.incognito);
  if (normal?.id !== undefined) return { id: normal.id };
  const created = await browser.windows.create({ url: 'about:blank', type: 'normal', state: 'minimized', focused: false });
  if (created?.id === undefined) throw new Error('Unable to create a normal browser window for search workers');
  const [tab] = await browser.tabs.query({ windowId: created.id });
  return { id: created.id, initialTabId: tab?.id };
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
    state.groupId = await browser.tabs.group({ tabIds: remaining as [number, ...number[]] });
    await browser.tabGroups.update(state.groupId, { title: GROUP_TITLE, color: 'grey', collapsed: true });
    await saveState(state);
  }
  for (const [id, tabId] of Object.entries(state.tabs) as [SourceId, number][]) {
    try {
      const tab = await browser.tabs.get(tabId);
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
  const { id: windowId, initialTabId } = await normalWindow();
  const existingGroup = (await browser.tabGroups.query({ windowId })).find((group) => group.title === GROUP_TITLE);
  let groupId = existingGroup?.id;
  let tab = groupId === undefined
    ? undefined
    : (await browser.tabs.query({ windowId, groupId })).find((candidate) => candidate.id !== undefined);
  if (!tab) {
    tab = initialTabId === undefined
      ? await browser.tabs.create({ windowId, url: 'about:blank', active: false })
      : await browser.tabs.get(initialTabId);
  }
  if (tab.id === undefined) throw new Error('Unable to create a worker tab');
  if (groupId === undefined) groupId = await browser.tabs.group({ tabIds: [tab.id] });
  else if (tab.groupId !== groupId) await browser.tabs.group({ tabIds: [tab.id], groupId });
  await browser.tabs.update(tab.id, { active: false, muted: true, autoDiscardable: false });
  await browser.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'grey', collapsed: true });
  const state: RendererState = {
    windowId,
    groupId,
    tabs: { [engineId]: tab.id },
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
  await browser.tabs.group({ tabIds: [tab.id], groupId: state.groupId });
  await browser.tabs.update(tab.id, { muted: true, autoDiscardable: false });
  await browser.tabGroups.update(state.groupId, { title: GROUP_TITLE, color: 'grey', collapsed: true });
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

async function restoreAfterCaptcha(request: PendingRequest): Promise<void> {
  try {
    const state = await readState();
    if (state) await browser.tabGroups.update(state.groupId, { collapsed: true });
    if (request.restoreTabId !== undefined) {
      await browser.tabs.update(request.restoreTabId, { active: true });
      const tab = await browser.tabs.get(request.restoreTabId);
      await browser.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // The original tab or worker group may have been closed.
  }
}

async function focusForCaptcha(
  request: PendingRequest,
  state: RendererState,
  focusOnCaptcha: boolean,
  force = false,
): Promise<void> {
  if (!force && (!focusOnCaptcha || request.focusedForCaptcha)) return;
  if (force) request.restoreTabId = undefined;
  try {
    const previousWindow = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
    if (previousWindow.id !== undefined && !previousWindow.incognito) {
      const tabs = await browser.tabs.query({ windowId: previousWindow.id, active: true });
      request.restoreTabId = tabs.find((tab) => tab.id !== request.tabId)?.id;
    }
    await browser.tabGroups.update(state.groupId, { collapsed: false });
    await browser.tabs.update(request.tabId, { active: true });
    await browser.windows.update(state.windowId, { focused: true });
    request.focusedForCaptcha = true;
  } catch {
    // Keep the request alive; the user can open the worker tab manually.
  }
}

export function runBrowserEngine(
  engine: BrowserEngine,
  query: string,
  opts: { count: number; signal: AbortSignal; onBlocked: (message: string) => void },
): Promise<SearchHit[]> {
  return enqueue(engine.id, async () => {
    const config = await loadConfig();
    const last = await withStateLock(async () => {
      const state = await ensureState(engine.id);
      return lastStarted.get(engine.id) ?? state.lastUsedByEngine[engine.id] ?? 0;
    });
    const waitFor = config.renderer.minIntervalMs - (Date.now() - last);
    if (waitFor > 0) await pause(waitFor, opts.signal);
    if (opts.signal.aborted) throw opts.signal.reason ?? new Error('Search cancelled');
    const { tabId, groupId } = await withStateLock(async () => {
      if (opts.signal.aborted) throw opts.signal.reason ?? new Error('Search cancelled');
      const currentState = await ensureState(engine.id);
      const tabId = await ensureWorkerTab(currentState, engine.id);
      if (opts.signal.aborted) throw opts.signal.reason ?? new Error('Search cancelled');
      const now = Date.now();
      lastStarted.set(engine.id, now);
      currentState.lastUsed = now;
      currentState.lastUsedByEngine[engine.id] = now;
      await saveState(currentState);
      return { tabId, groupId: currentState.groupId };
    });
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
        .update(tabId, { url: engine.buildUrl(query, opts.count), active: false, muted: true, autoDiscardable: false })
        .then(() => browser.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'grey', collapsed: true }))
        .catch((error) => {
          cleanup();
          pending.cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  });
}

export function workerForTab(tabId: number | undefined): { engine: SourceId; requestId: string } | null {
  if (tabId === undefined) return null;
  const request = pendingByTab.get(tabId);
  return request ? workerIdentity(request.engine.id, request.requestId) : null;
}

export async function handleWorkerMessage(message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> {
  const msg = message as { type?: string; requestId?: string; source?: string; hits?: Omit<SearchHit, 'source'>[] };
  const tabId = sender.tab?.id;
  if (msg?.type === 'kiwi:worker?') {
    const pending = workerForTab(tabId);
    return pending ? { type: 'kiwi:worker!', ...pending } : { type: 'kiwi:not-worker' };
  }
  if (msg?.type === 'kiwi:blocked' && tabId !== undefined) {
    const request = pendingById.get(msg.requestId ?? '');
    if (request && request.tabId === tabId) {
      const state = await withStateLock(() => readState());
      const config = await loadConfig();
      request.onBlocked('需要在搜索引擎页面手动完成验证');
      if (state) await focusForCaptcha(request, state, config.renderer.focusOnCaptcha);
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
        await browser.tabGroups.update(state.groupId, { collapsed: false });
        await browser.tabs.update(tabId, { active: true });
        await browser.windows.update(state.windowId, { focused: true });
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
