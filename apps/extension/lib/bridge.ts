import { isSearchMode, runSearch, usableSources, type Env, type FusionConfig, type RunOptions, type SourceId } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
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
  options?: { sources?: SourceId[]; summarize?: boolean; limit?: number; mode?: string };
}

let ws: WebSocket | null = null;
let connecting = false;
let pingTimer: ReturnType<typeof setInterval> | undefined;
const inflight = new Map<string, AbortController>();

export async function ensureBridge(makeEnv: () => Env): Promise<void> {
  const settings = await loadBridge();
  if (!settings.enabled) {
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
      throw new Error('MCP answer 需要 API 摘要提供方；请在 Kiwi Search 设置中选择 OpenAI 兼容 API。');
    }
    const opts: RunOptions = {
      mode: isSearchMode(msg.options?.mode) ? msg.options.mode : undefined,
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
    if (!msg.query) throw new Error('MCP 请求缺少 query');
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
