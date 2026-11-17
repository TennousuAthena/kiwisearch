import type { BlockReason, BrowserEngine, BrowserRunOptions, SearchHit, SearchMode, SourceId } from '@kiwi-search/core';
import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import { t } from '@kiwi-search/app/i18n';
import { createAsyncLock, isBrowserErrorPage, parseRendererState, workerIdentity, type RendererState } from './rendererState';
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
  /** The content script in the worker tab has said hello: the page loaded and is one the engine reads. */
  handshaken?: boolean;
  cleanup: () => void;
}

/** How long after a worker page finished loading the content script may take to say hello. */
const HANDSHAKE_GRACE_MS = 4000;

const STORAGE_KEY = 'kiwiRenderer';
const withStateLock = createAsyncLock();
let cachedState: RendererState | undefined;
let statePromise: Promise<RendererState | null> | undefined;
const pendingById = new Map<string, PendingRequest>();
const pendingByTab = new Map<number, PendingRequest>();
const queues = new Map<SourceId, Promise<unknown>>();
const lastStarted = new Map<SourceId, number>();
/** Relinquish immediately, even while the state lock is busy. IDs last only for this browser session. */
const releasedTabs = new Set<number>();

async function readState(): Promise<RendererState | null> {
  if (cachedState) return cachedState;
  statePromise ??= browser.storage.session.get(STORAGE_KEY).then(({ [STORAGE_KEY]: saved }) => {
    cachedState = parseRendererState(saved) ?? undefined;
    return cachedState ?? null;
  });
  try {
    return await statePromise;
  } finally {
    statePromise = undefined;
  }
}

async function saveState(state: RendererState): Promise<void> {
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

/** Grouping, pinning or moving a worker hands it to the user; never adopt it again by title or URL. */
function ownsTab(state: RendererState, tab: Browser.tabs.Tab): boolean {
  return tab.id !== undefined && !releasedTabs.has(tab.id) && tab.windowId === state.windowId &&
    (tab.groupId === undefined || tab.groupId === -1) && !tab.pinned;
}

async function validState(state: RendererState | null): Promise<RendererState | null> {
  if (!state) return null;
  try {
    const window = await browser.windows.get(state.windowId);
    if (window.incognito || window.type !== 'normal') return null;
  } catch {
    return null;
  }
  let changed = false;
  for (const [id, tabId] of Object.entries(state.tabs) as [SourceId, number][]) {
    try {
      if (ownsTab(state, await browser.tabs.get(tabId))) continue;
    } catch {
      // The user closed this tab or its window.
    }
    delete state.tabs[id];
    delete state.lastUsedByEngine[id];
    changed = true;
  }
  if (changed) await saveState(state);
  return state;
}

async function ensureState(engineId: SourceId): Promise<RendererState> {
  const existing = await validState(await readState());
  if (existing) return existing;
  const { id: windowId, initialTabId } = await createWorkerWindow();
  const tabId = initialTabId ?? (await browser.tabs.create({ windowId, url: 'about:blank', active: false })).id;
  if (tabId === undefined) throw new Error('Unable to create a worker tab');
  await browser.tabs.update(tabId, { muted: true, autoDiscardable: false });
  const state: RendererState = {
    windowId,
    version: 2,
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
      if (ownsTab(state, tab)) return existingId;
    } catch {
      // Recreate a worker tab that the user or browser closed.
    }
    delete state.tabs[engineId];
  }
  const tab = await browser.tabs.create({ windowId: state.windowId, url: 'about:blank', active: false });
  if (tab.id === undefined) throw new Error(`Unable to create ${engineId} worker tab`);
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
      // A page that failed to load is the browser's error page, where no content script runs; without this the source would wait out its timeout.
      const onTabUpdated = (updatedId: number, changeInfo: { status?: string; url?: string }, tab: { url?: string }) => {
        if (updatedId !== tabId || !pendingById.has(requestId)) return;
        if (changeInfo.status !== 'complete') return;
        const fail = () => {
          if (!pendingById.has(requestId)) return;
          cleanup();
          pending.cleanup();
          reject(new Error(t('worker.renderer.pageNotOpened')));
        };
        if (isBrowserErrorPage(tab.url ?? changeInfo.url)) {
          fail();
          return;
        }
        // The content script says hello as soon as a page it reads has loaded; the browser's own error pages (an HTTP 403 keeps
        // the requested address) and pages it doesn't read never do. Failing here beats waiting out the source's timeout.
        setTimeout(() => !pending.handshaken && fail(), HANDSHAKE_GRACE_MS);
      };
      const cleanup = () => {
        browser.tabs.onUpdated.removeListener(onTabUpdated);
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
        cleanup: () => {
          opts.signal.removeEventListener('abort', onAbort);
          browser.tabs.onUpdated.removeListener(onTabUpdated);
        },
      };
      pendingById.set(requestId, pending);
      pendingByTab.set(tabId, pending);
      opts.signal.addEventListener('abort', onAbort, { once: true });
      browser.tabs.onUpdated.addListener(onTabUpdated);
      void browser.tabs
        .update(tabId, { url: engine.buildUrl(query, opts.count, opts.mode, opts.language, opts.news), active: false, muted: true, autoDiscardable: false })
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
  const msg = message as { type?: string; requestId?: string; source?: string; reason?: BlockReason; text?: string; hits?: Omit<SearchHit, 'source'>[] };
  const tabId = sender.tab?.id;
  if (msg?.type === 'kiwi:worker?' && tabId !== undefined) {
    const waiting = pendingByTab.get(tabId);
    if (waiting) waiting.handshaken = true;
  }
  if (msg?.type === 'kiwi:worker?') {
    const pending = workerForTab(tabId);
    return pending ? { type: 'kiwi:worker!', ...pending } : { type: 'kiwi:not-worker' };
  }
  if (msg?.type === 'kiwi:blocked' && tabId !== undefined) {
    const request = pendingById.get(msg.requestId ?? '');
    if (request && request.tabId === tabId) {
      const state = await withStateLock(() => readState());
      const reason: BlockReason = msg.reason === 'login' ? 'login' : 'captcha';
      request.onBlocked(reason === 'login' ? t('worker.renderer.needsLogin') : t('worker.renderer.needsVerification'), reason);
      // Only a captcha may bring the window forward by itself; a login wall waits for the user to ask.
      if (state) await focusForCaptcha(request, state, request.focusOnCaptcha && reason === 'captcha');
    }
    return { ok: true };
  }
  if (msg?.type === 'kiwi:refused' && tabId !== undefined) {
    const request = pendingById.get(msg.requestId ?? '');
    if (request && request.tabId === tabId) {
      pendingById.delete(request.requestId);
      pendingByTab.delete(tabId);
      request.cleanup();
      request.reject(new Error(t('worker.renderer.refused', { reason: msg.text ?? '' })));
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
  if (msg?.type === 'kiwi:focus-worker' && typeof msg.source === 'string') return { ok: await focusWorker(msg.source) };
  return undefined;
}

/** Brings the worker tab of a source to the front, so the user can solve a captcha or sign in. False if that source has no worker tab. */
export async function focusWorker(source: string): Promise<boolean> {
  const state = await withStateLock(async () => validState(await readState()));
  const tabId = state?.tabs[source as SourceId];
  if (state && tabId !== undefined) {
    const request = pendingByTab.get(tabId);
    if (request) {
      await focusForCaptcha(request, state, false, true);
    } else {
      await browser.windows.update(state.windowId, { state: 'normal', focused: true });
      await browser.tabs.update(tabId, { active: true });
    }
  }
  return !!tabId;
}

export async function collectIdleWorkers(): Promise<void> {
  const config = await loadConfig();
  await withStateLock(async () => {
    const state = await validState(await readState());
    if (!state) {
      cachedState = undefined;
      await browser.storage.session.remove(STORAGE_KEY);
      return;
    }
    const maxIdle = config.renderer.workerIdleMinutes * 60_000;
    const now = Date.now();
    for (const [source, tabId] of Object.entries(state.tabs) as [SourceId, number][]) {
      // Includes rate-limited/queued searches and the gap before their pending request is registered.
      if (queues.has(source) || pendingByTab.has(tabId)) continue;
      if (now - (state.lastUsedByEngine[source] ?? state.lastUsed) < maxIdle) continue;
      try {
        // Recheck after the earlier awaits: the user may have taken this tab in the meantime.
        if (ownsTab(state, await browser.tabs.get(tabId))) await browser.tabs.remove(tabId);
      } catch {
        // Already closed.
      }
      delete state.tabs[source];
      delete state.lastUsedByEngine[source];
    }
    if (Object.keys(state.tabs).length) {
      await saveState(state);
    } else {
      cachedState = undefined;
      await browser.storage.session.remove(STORAGE_KEY);
    }
  });
}

export function handleWorkerTabUpdated(tabId: number, change: { pinned?: boolean; groupId?: number }): void {
  if (change.pinned || (change.groupId !== undefined && change.groupId !== -1)) forgetWorkerTab(tabId);
}

export function forgetWorkerTab(tabId: number): void {
  releasedTabs.add(tabId);
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
      if (workerTab === tabId) {
        delete state.tabs[id];
        delete state.lastUsedByEngine[id];
      }
    }
    await saveState(state);
  }).finally(() => releasedTabs.delete(tabId)).catch(() => {});
}
