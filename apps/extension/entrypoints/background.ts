import { runSearch, type Env } from '@fusion-search/core';
import { browser } from 'wxt/browser';
import { ensureBridge } from '@/lib/bridge';
import type { PortMessage, SearchRequest } from '@/lib/messages';
import { loadConfig } from '@/lib/settings';
import { collectIdleWorkers, forgetWorkerTab, handleWorkerMessage, runBrowserEngine } from '@/lib/tabRenderer';

export default defineBackground(() => {
  const makeEnv = (): Env => ({
    fetch: (input, init) => fetch(input, init),
    runBrowserEngine,
  });

  browser.runtime.onInstalled.addListener(() => {
    browser.runtime.openOptionsPage?.().catch(() => {});
  });

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (typeof (msg as { type?: string })?.type !== 'string' || !(msg as { type: string }).type.startsWith('fusion:')) return false;
    void handleWorkerMessage(msg, sender).then(sendResponse).catch((error) => sendResponse({ error: String(error) }));
    return true;
  });
  browser.tabs.onRemoved.addListener(forgetWorkerTab);

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'search') return;
    let ctrl: AbortController | null = null;
    const post = (m: PortMessage) => {
      try {
        port.postMessage(m);
      } catch {
        ctrl?.abort();
      }
    };
    port.onDisconnect.addListener(() => ctrl?.abort());
    port.onMessage.addListener(async (raw) => {
      const req = raw as SearchRequest;
      if (req.type === 'keepalive') return;
      if (req.type !== 'search') return;
      ctrl?.abort();
      const current = (ctrl = new AbortController());
      try {
        const config = await loadConfig();
        await runSearch(req.query, config, makeEnv(), {
          sources: req.sources,
          summarize: req.summarize,
          signal: current.signal,
          onEvent: (event) => !current.signal.aborted && post({ type: 'event', event }),
        });
      } catch (e) {
        if (!current.signal.aborted) post({ type: 'fatal', error: e instanceof Error ? e.message : String(e) });
      }
    });
  });

  // Keep trying to reach the local MCP server (cheap no-op when connected).
  void ensureBridge(makeEnv);
  browser.alarms.create('bridge', { periodInMinutes: 0.5 });
  browser.alarms.create('fusion-worker-gc', { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === 'bridge') void ensureBridge(makeEnv);
    else if (a.name === 'fusion-worker-gc') void collectIdleWorkers();
  });
  browser.storage.onChanged.addListener((changes) => changes.bridge && void ensureBridge(makeEnv));
});
