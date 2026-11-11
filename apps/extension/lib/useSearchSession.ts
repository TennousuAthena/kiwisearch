import type { SearchMode, SourceId } from '@kiwi-search/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import { promptWithBuiltinModel } from './builtinModel';
import type { PortMessage, SearchRequest } from './messages';
import { emptyState, lateSourcesAfterDone, reduce, type SearchState } from './searchState';

const BUILTIN_MODEL_FIRST_CHUNK_TIMEOUT_MS = 60000;
const KEEPALIVE_MS = 20000;

/**
 * One search at a time over a port to the service worker: streams pipeline events into
 * `SearchState`, keeps the worker alive while results are still expected, and runs the summary in
 * the page when the provider is Chrome's built-in model (it only exists in page contexts).
 */
export function useSearchSession() {
  const [state, setState] = useState<SearchState | null>(null);
  const portRef = useRef<Browser.runtime.Port | null>(null);
  const keepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const builtinModelRef = useRef<AbortController | null>(null);
  const builtinModelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const teardown = useCallback(() => {
    builtinModelRef.current?.abort();
    builtinModelRef.current = null;
    if (builtinModelTimeoutRef.current) clearTimeout(builtinModelTimeoutRef.current);
    builtinModelTimeoutRef.current = null;
    if (keepaliveRef.current) clearInterval(keepaliveRef.current);
    keepaliveRef.current = null;
    portRef.current?.disconnect();
    portRef.current = null;
  }, []);

  const search = useCallback(
    (query: string, mode: SearchMode) => {
      teardown();
      const port = browser.runtime.connect({ name: 'search' });
      portRef.current = port;
      const isCurrent = () => portRef.current === port;
      const deferred = new Set<SourceId>();
      let doneReceived = false;
      const stopKeepaliveIfSettled = () => {
        if (!doneReceived || deferred.size > 0) return;
        if (keepaliveRef.current) clearInterval(keepaliveRef.current);
        keepaliveRef.current = null;
      };
      keepaliveRef.current = setInterval(() => {
        if (!isCurrent()) return;
        try {
          port.postMessage({ type: 'keepalive' });
        } catch {
          portRef.current = null;
          if (keepaliveRef.current) clearInterval(keepaliveRef.current);
          keepaliveRef.current = null;
        }
      }, KEEPALIVE_MS);
      port.onDisconnect.addListener(() => {
        if (!isCurrent()) return;
        portRef.current = null;
        if (keepaliveRef.current) clearInterval(keepaliveRef.current);
        keepaliveRef.current = null;
      });
      setState(emptyState(query, mode));

      const runBuiltinModel = (messages: Parameters<typeof promptWithBuiltinModel>[0]) => {
        const controller = new AbortController();
        builtinModelRef.current = controller;
        let timedOut = false;
        let receivedFirstChunk = false;
        const current = () => isCurrent() && builtinModelRef.current === controller;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
          if (current()) {
            setState((s) => s && { ...s, summaryStatus: 'error', summaryError: '浏览器内置模型在 60 秒内未返回首个内容块，请检查模型状态后重试。' });
          }
        }, BUILTIN_MODEL_FIRST_CHUNK_TIMEOUT_MS);
        builtinModelTimeoutRef.current = timeout;
        void promptWithBuiltinModel(
          messages,
          (delta) => {
            if (!current() || timedOut) return;
            if (!receivedFirstChunk) {
              receivedFirstChunk = true;
              clearTimeout(timeout);
              if (builtinModelTimeoutRef.current === timeout) builtinModelTimeoutRef.current = null;
            }
            setState((s) => s && { ...s, summary: s.summary + delta, summaryStatus: 'streaming' });
          },
          controller.signal,
        )
          .then(() => {
            if (current() && !timedOut) setState((s) => s && { ...s, summaryStatus: 'done' });
          })
          .catch((error) => {
            if (!current() || timedOut) return;
            const detail = error instanceof Error ? error.message : String(error);
            setState((s) => s && { ...s, summaryStatus: 'error', summaryError: `浏览器内置模型启动或生成失败：${detail}` });
          })
          .finally(() => {
            clearTimeout(timeout);
            if (builtinModelTimeoutRef.current === timeout) builtinModelTimeoutRef.current = null;
            if (builtinModelRef.current === controller) builtinModelRef.current = null;
          });
      };

      port.onMessage.addListener((raw: unknown) => {
        if (!isCurrent()) return;
        const msg = raw as PortMessage;
        if (msg.type === 'fatal') {
          doneReceived = true;
          deferred.clear();
          stopKeepaliveIfSettled();
          setState((s) => s && { ...s, fatal: msg.error, stage: 'done', finishedAt: Date.now() });
          return;
        }
        const event = msg.event;
        if (event.type === 'source_blocked') deferred.add(event.source);
        if (event.type === 'late_results' || event.type === 'source_error') deferred.delete(event.source);
        setState((s) => s && reduce(s, event));
        if (event.type === 'done') {
          // Sources still running at the soft deadline report after `done`.
          for (const id of lateSourcesAfterDone(event)) deferred.add(id);
          doneReceived = true;
        }
        stopKeepaliveIfSettled();
        if (event.type === 'summary_prompt') runBuiltinModel(event.messages);
      });
      const request: SearchRequest = { type: 'search', query, mode };
      port.postMessage(request);
    },
    [teardown],
  );

  const reset = useCallback(() => {
    teardown();
    setState(null);
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  return { state, search, reset };
}
