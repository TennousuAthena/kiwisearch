import { runSearch, type Env, type SourceId } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { ensureBridge } from '@/lib/bridge';
import type { PortMessage, SearchRequest } from '@/lib/messages';
import { loadConfig } from '@/lib/settings';
import { collectIdleWorkers, forgetWorkerTab, handleWorkerMessage, runBrowserEngine } from '@/lib/tabRenderer';

export default defineBackground(() => {
  const searchRedirectRuleId = 1001;
  const ensureSearchRedirectRule = async () => {
    await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [searchRedirectRuleId] });
    await browser.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: searchRedirectRuleId,
        priority: 1,
        action: {
          type: 'redirect',
          redirect: { regexSubstitution: browser.runtime.getURL('/newtab.html') + '?\\1' },
        },
        condition: {
          regexFilter: '^https://s\\.kiwi\\.moe/s\\?(.*)$',
          resourceTypes: ['main_frame'],
        },
      }],
    });
  };
  let searchRedirectRegistration: Promise<void> | null = null;
  const registerSearchRedirectRule = () => {
    if (searchRedirectRegistration) return;
    searchRedirectRegistration = ensureSearchRedirectRule()
      .catch((error) => console.error('Could not register Kiwi Search redirect rule:', error))
      .finally(() => {
        searchRedirectRegistration = null;
      });
  };

  const makeEnv = (): Env => ({
    fetch: (input, init) => fetch(input, init),
    runBrowserEngine,
  });

  browser.runtime.onInstalled.addListener(() => {
    registerSearchRedirectRule();
    browser.runtime.openOptionsPage?.().catch(() => {});
  });
  browser.runtime.onStartup.addListener(registerSearchRedirectRule);
  registerSearchRedirectRule();

  browser.omnibox.setDefaultSuggestion({ description: '用 Kiwi Search 搜索：%s' });
  browser.omnibox.onInputEntered.addListener((text, disposition) => {
    const url = `${browser.runtime.getURL('/newtab.html')}?q=${encodeURIComponent(text)}`;
    if (disposition === 'currentTab') {
      void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id !== undefined) return browser.tabs.update(tab.id, { url });
        return browser.tabs.create({ url, active: true });
      });
      return;
    }
    void browser.tabs.create({ url, active: disposition === 'newForegroundTab' });
  });

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (typeof (msg as { type?: string })?.type !== 'string' || !(msg as { type: string }).type.startsWith('kiwi:')) return false;
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
      const deferredSources = new Set<SourceId>();
      let searchFinished = false;
      let resolveDeferred!: () => void;
      const deferredSettled = new Promise<void>((resolve) => {
        resolveDeferred = resolve;
      });
      const maybeResolveDeferred = () => {
        if (searchFinished && deferredSources.size === 0) resolveDeferred();
      };
      try {
        const config = await loadConfig();
        await runSearch(req.query, config, makeEnv(), {
          sources: req.sources,
          summarize: req.summarize,
          signal: current.signal,
          onEvent: (event) => {
            if (event.type === 'source_blocked') deferredSources.add(event.source);
            if (event.type === 'late_results' || event.type === 'source_error') deferredSources.delete(event.source);
            maybeResolveDeferred();
            if (!current.signal.aborted) post({ type: 'event', event });
          },
        });
        searchFinished = true;
        maybeResolveDeferred();
        if (deferredSources.size > 0 && !current.signal.aborted) {
          let onAbort!: () => void;
          const aborted = new Promise<void>((resolve) => {
            onAbort = resolve;
            current.signal.addEventListener('abort', onAbort, { once: true });
          });
          if (current.signal.aborted) onAbort();
          await Promise.race([deferredSettled, aborted]);
          current.signal.removeEventListener('abort', onAbort);
        }
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
