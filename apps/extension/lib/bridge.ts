import { isAcademicLanguage, isSearchMode, normalizeNewsOptions, runSearch, usableSources, type Env, type FusionConfig, type NewsOptions, type RunOptions, type SourceId } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { t } from './i18n';
import { loadBridge, loadConfig } from './settings';
import { recordSourceStatus } from './sourceStatus';

/**
 * WebSocket client that lets the local MCP server (packages/mcp) run searches
 * through this extension, so MCP tools get browser-only sources (Google etc.).
 */
interface BridgeRequest {
  id: string;
  type: 'search' | 'answer' | 'list_sources';
  query?: string;
  options?: { sources?: SourceId[]; summarize?: boolean; limit?: number; mode?: string; language?: string; news?: Partial<NewsOptions>; refresh?: boolean };
}

let ws: WebSocket | null = null;
let connecting = false;
let pingTimer: ReturnType<typeof setInterval> | undefined;
const inflight = new Map<string, AbortController>();

export async function ensureBridge(makeEnv: () => Env): Promise<void> {
  const settings = await loadBridge();
  // Without a token the hub would reject the hello anyway, so an unpaired bridge stays quiet.
  if (!settings.enabled || !settings.token) {
    ws?.close();
    return;
  }
  if (connecting || (ws && ws.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  try {
    const sock = new WebSocket(`ws://127.0.0.1:${settings.port}/extension`);
    ws = sock;
    sock.onopen = async () => {
      const config = await loadConfig();
      if (sock.readyState !== WebSocket.OPEN) return;
      sock.send(JSON.stringify({ type: 'hello', token: settings.token, version: browser.runtime.getManifest().version, sources: describeSources(config) }));
      clearInterval(pingTimer);
      // WebSocket traffic keeps the MV3 service worker alive (Chrome 116+).
      pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('{"type":"ping"}'), 20000);
    };
    sock.onmessage = (ev) => void onMessage(sock, String(ev.data), makeEnv);
    sock.onclose = () => {
      clearInterval(pingTimer);
      inflight.forEach((c) => c.abort());
      inflight.clear();
      if (ws === sock) ws = null;
    };
    sock.onerror = () => {};
  } finally {
    connecting = false;
  }
}

function describeSources(config: FusionConfig) {
  return usableSources(config, true).map(({ id, reason, modes }) => ({ id, available: !reason, reason, modes }));
}

async function onMessage(sock: WebSocket, raw: string, makeEnv: () => Env) {
  let msg: BridgeRequest | { type: 'cancel'; id: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === 'cancel') {
    inflight.get(msg.id)?.abort();
    return;
  }
  if (!['search', 'answer', 'list_sources'].includes(msg.type)) return;
  const send = (payload: object) => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ id: msg.id, ...payload }));
  if (msg.type === 'list_sources') {
    const config = await loadConfig();
    send({ type: 'result', result: { sources: describeSources(config) } });
    return;
  }
  const ctrl = new AbortController();
  inflight.set(msg.id, ctrl);
  const blockedSources = new Set<SourceId>();
  try {
    const config = await loadConfig();
    if (msg.type === 'answer' && config.summary.provider === 'chrome-builtin') {
      throw new Error(t('worker.bridge.answerNeedsApi'));
    }
    const opts: RunOptions = {
      mode: isSearchMode(msg.options?.mode) ? msg.options.mode : undefined,
      language: isAcademicLanguage(msg.options?.language) ? msg.options.language : undefined,
      news: msg.options?.mode === 'news' ? normalizeNewsOptions(msg.options.news) : undefined,
      refresh: msg.options?.refresh === true,
      sources: msg.options?.sources,
      summarize: msg.options?.summarize ?? msg.type === 'answer',
      limit: msg.options?.limit,
      signal: ctrl.signal,
      onEvent: (event) => {
        recordSourceStatus(event);
        if (event.type === 'source_blocked') {
          blockedSources.add(event.source);
          send({ type: 'progress', event });
        } else if ((event.type === 'source_done' || event.type === 'source_error') && !blockedSources.has(event.source)) {
          send({ type: 'progress', event });
        }
      },
    };
    if (!msg.query) throw new Error(t('worker.bridge.missingQuery'));
    const result = await runSearch(msg.query, config, makeEnv(), opts);
    ctrl.abort();
    send({ type: 'result', result });
  } catch (e) {
    send({ type: 'error', error: e instanceof Error ? e.message : String(e) });
  } finally {
    ctrl.abort();
    inflight.delete(msg.id);
  }
}
