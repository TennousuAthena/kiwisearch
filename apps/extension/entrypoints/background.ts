import { createSourceCache, llmUsable, runSearch, summarizeSnapshot, usableSources, type Env, type SourceId } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { ensureBridge } from '@/lib/bridge';
import { handleBlocklistMessage, loadBlocklistRules, refreshDueBlocklists } from '@/lib/blocklistService';
import { subscriptionsChanged } from '@/lib/blocklistState';
import { initLocale, t } from '@/lib/i18n';
import { coreMessagesFor } from '@/lib/i18n/coreMessages';
import type { PortMessage, SearchRequest } from '@/lib/messages';
import { handleConfigUpdate, isConfigUpdateMessage } from '@/lib/backgroundConfig';
import { isExtensionPageSender, parseSummaryRequest } from '@/lib/summaryRequest';
import { browserLanguage } from '@/lib/language';
import { loadConfig } from '@/lib/settings';
import { handleFaviconMessage } from '@/lib/faviconService';
import { handleDecisionTest, handleLlmTest } from '@/lib/llmTest';
import { recordSourceStatus } from '@/lib/sourceStatus';
import { collectIdleWorkers, forgetWorkerTab, handleWorkerMessage, runBrowserEngine } from '@/lib/tabRenderer';

/** The new-tab page shows results once the fast sources are in; slower ones merge in afterwards. */
const UI_SOFT_DEADLINE_MS = 6000;

export default defineBackground(() => {
  initLocale();
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

  // Shared by the new-tab page and the MCP bridge, so repeat queries skip the rate-limited engines.
  const cache = createSourceCache();
  const makeEnv = (): Env => ({
    fetch: (input, init) => fetch(input, init),
    runBrowserEngine,
    cache,
    loadBlocklists: loadBlocklistRules,
    // The AI overview is written in the browser's language unless the settings say otherwise. Read at each search, so a changed browser language counts at once.
    browserLanguage: browserLanguage(),
    // The few sentences core writes for the user (why a feature was skipped), in the interface language.
    messages: coreMessagesFor(),
  });

  browser.runtime.onInstalled.addListener(({ reason }) => {
    registerSearchRedirectRule();
    if (reason === 'install') browser.runtime.openOptionsPage?.().catch(() => {});
  });
  browser.runtime.onStartup.addListener(registerSearchRedirectRule);
  registerSearchRedirectRule();

  // Subscribed block lists: brought up to date whenever the worker starts (browser start included; a no-op unless one is due),
  // every few hours by alarm, and when a subscription is switched on or added.
  const refreshSubscribedLists = () => void refreshDueBlocklists().catch(() => {});
  refreshSubscribedLists();
  // `alarms.create` with a name in use starts that alarm over, and the worker is restarted more often than the alarm's period.
  void browser.alarms.get('blocklist-refresh').then((alarm) => {
    if (!alarm) browser.alarms.create('blocklist-refresh', { delayInMinutes: 60, periodInMinutes: 360 });
  });

  browser.omnibox.setDefaultSuggestion({ description: t('omnibox.suggestion') });
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
    const type = (msg as { type: string }).type;
    if (isConfigUpdateMessage(msg)) {
      if (!isExtensionPageSender(sender, browser.runtime.id, browser.runtime.getURL('/'))) return false;
      void handleConfigUpdate(msg).then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }
    const reply =
      type === 'kiwi:favicon'
        ? handleFaviconMessage(msg)
        : type === 'kiwi:test-llm'
          ? handleLlmTest(msg)
          : type === 'kiwi:test-decision'
            ? handleDecisionTest(msg)
            : type === 'kiwi:blocklist-refresh'
              ? handleBlocklistMessage(msg)
              : handleWorkerMessage(msg, sender);
    void reply.then(sendResponse).catch((error) => sendResponse({ error: String(error) }));
    return true;
  });
  browser.tabs.onRemoved.addListener(forgetWorkerTab);

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'search' && port.name !== 'summary') return;
    if (!isExtensionPageSender(port.sender, browser.runtime.id, browser.runtime.getURL('/'))) { port.disconnect(); return; }
    let ctrl: AbortController | null = null;
    let summaryCtrl: AbortController | null = null;
    const post = (m: PortMessage) => {
      try {
        port.postMessage(m);
      } catch {
        ctrl?.abort();
      }
    };
    port.onDisconnect.addListener(() => { ctrl?.abort(); summaryCtrl?.abort(); });
    port.onMessage.addListener(async (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const req = raw as SearchRequest;
      if (req.type === 'keepalive') return;
      if (req.type === 'stop-summary') { summaryCtrl?.abort(); return; }
      if (port.name === 'summary') {
        const request = parseSummaryRequest(raw);
        if (!request) { post({ type: 'fatal', error: t('newtab.session.invalidRequest') }); return; }
        ctrl?.abort();
        const current = (ctrl = new AbortController());
        try {
          const config = await loadConfig();
          if (current.signal.aborted) return;
          if (config.summary.provider !== 'chrome-builtin' && !llmUsable(config.llm)) {
            post({ type: 'fatal', error: t('newtab.session.summaryUnavailable') }); return;
          }
          if (!request.results.some((r) => !r.hidden && (r.snippet || r.content))) {
            post({ type: 'fatal', error: t('newtab.session.summaryNoEvidence') }); return;
          }
          await summarizeSnapshot(request.query, request.results, config, makeEnv(), {
            mode: request.mode, news: request.news, reuse: request.reuse, summaryAt: request.summaryAt, signal: current.signal,
            onEvent: (event) => { if (!current.signal.aborted) post({ type: 'event', event }); },
            onSnapshot: (results, summaryAt) => { if (!current.signal.aborted) post({ type: 'summary-snapshot', results, summaryAt }); },
          });
        } catch (error) {
          if (!current.signal.aborted) post({ type: 'fatal', error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (req.type !== 'search') return;
      if (typeof req.query !== 'string' || !req.query.trim() || req.query.length > 4096) {
        post({ type: 'fatal', error: t('newtab.session.invalidRequest') }); return;
      }
      ctrl?.abort();
      summaryCtrl?.abort();
      const current = (ctrl = new AbortController());
      const overview = (summaryCtrl = new AbortController());
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
        if (current.signal.aborted) return;
        const sources = usableSources(config, true, req.mode ?? 'web').filter((source) => source.modes.includes(req.mode ?? 'web') && (!req.sources || req.sources.includes(source.id)));
        post({ type: 'readiness', enabled: sources.filter((source) => source.reason !== 'disabled').length, ready: sources.filter((source) => !source.reason).length });
        await runSearch(req.query, config, makeEnv(), {
          mode: req.mode,
          language: req.language,
          news: req.news,
          refresh: req.refresh,
          sources: req.sources,
          summarize: req.summarize,
          summarySignal: overview.signal,
          onSummarySnapshot: (results, summaryAt) => { if (!current.signal.aborted) post({ type: 'summary-snapshot', results, summaryAt }); },
          softDeadlineMs: UI_SOFT_DEADLINE_MS,
          signal: current.signal,
          onEvent: (event) => {
            recordSourceStatus(event);
            if (event.type === 'source_blocked') deferredSources.add(event.source);
            // Sources still running at the soft deadline report after `done`; keep the port open for them.
            if (event.type === 'done') {
              for (const stat of event.result.sourceStats) if (stat.status === 'late') deferredSources.add(stat.source);
            }
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
    else if (a.name === 'blocklist-refresh') refreshSubscribedLists();
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (changes.bridge) void ensureBridge(makeEnv);
    if (area === 'local' && subscriptionsChanged(changes.config)) refreshSubscribedLists();
  });
});
