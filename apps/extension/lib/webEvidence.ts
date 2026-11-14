import type { FusedResult } from '@kiwi-search/core';
import type { PortMessage, SummaryRequest } from '@kiwi-search/protocol';

/**
 * What the extension itself sent to a website page, kept per tab, so that a summary asked for by that page is built from the extension's own copy of
 * the results and never from what the page sends back.
 *
 * Without this a website could name any address in a summary request: the extension would fetch it with its own permissions (the local network
 * included, and a public address that redirects there, or a name that resolves there, passes any check on the address) and return the text to the
 * page in the summary snapshot. It could also send `reuse` with text of its own, which the summary takes as already checked for prompt injection.
 * Here the page names results by `key`; the address, title, snippet and the rest come from what was emitted, and text counts as checked only if it
 * came out of an earlier summary of this tab.
 */

interface Entry {
  /** As emitted by a search, without `content`. */
  result: FusedResult;
  /** Text a source delivered with the result (not checked yet; a summary checks it). */
  sourceContent?: string;
  /** Text an earlier summary of this tab fetched and checked: the only text `reuse` may use. */
  checked?: string;
}

export type EvidenceEntries = Array<[string, Entry]>;

export interface EvidenceStorage {
  load(tabId: number): Promise<EvidenceEntries | undefined>;
  save(tabId: number, entries: EvidenceEntries): Promise<void>;
  drop(tabId: number): Promise<void>;
}

export interface EvidenceLimits { maxResults: number; maxTabs: number; saveDelayMs: number }
const DEFAULT_LIMITS: EvidenceLimits = { maxResults: 400, maxTabs: 4, saveDelayMs: 400 };

export function createEvidenceStore(storage?: EvidenceStorage, limits: Partial<EvidenceLimits> = {}) {
  const { maxResults, maxTabs, saveDelayMs } = { ...DEFAULT_LIMITS, ...limits };
  const tabs = new Map<number, Map<string, Entry>>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  const touch = (tabId: number): Map<string, Entry> => {
    let tab = tabs.get(tabId);
    if (tab) { tabs.delete(tabId); } else tab = new Map();
    tabs.set(tabId, tab);
    while (tabs.size > maxTabs) {
      const oldest = tabs.keys().next().value as number;
      tabs.delete(oldest);
      void storage?.drop(oldest).catch(() => {});
    }
    return tab;
  };

  const scheduleSave = (tabId: number) => {
    if (!storage || timers.has(tabId)) return;
    timers.set(tabId, setTimeout(() => {
      timers.delete(tabId);
      const tab = tabs.get(tabId);
      if (tab) void storage.save(tabId, [...tab]).catch(() => {});
    }, saveDelayMs));
  };

  const keep = (tab: Map<string, Entry>, result: FusedResult, patch: (entry: Entry) => Entry) => {
    const { content, ...rest } = result;
    const previous = tab.get(result.key);
    // Re-inserting puts the result last, so the ones dropped first are the oldest.
    tab.delete(result.key);
    tab.set(result.key, patch({ result: rest as FusedResult, sourceContent: content ?? previous?.sourceContent, checked: previous?.checked }));
    while (tab.size > maxResults) tab.delete(tab.keys().next().value as string);
  };

  /** Notes what was just sent to the page. */
  function record(tabId: number, message: PortMessage): void {
    let results: FusedResult[] | undefined;
    let fromSummary = false;
    if (message.type === 'event') {
      const event = message.event;
      if (event.type === 'fused' || event.type === 'late_results' || event.type === 'reranked' || event.type === 'judged') results = event.results;
      else if (event.type === 'done') results = event.result.results;
    } else if (message.type === 'summary-snapshot') {
      results = message.results;
      fromSummary = true;
    }
    if (!results?.length) return;
    const tab = touch(tabId);
    for (const result of results) {
      if (!result || typeof result.key !== 'string') continue;
      if (fromSummary) {
        // A summary's snapshot carries the text it fetched and checked, and only that text may come back with `reuse`.
        const known = tab.get(result.key);
        if (known && typeof result.content === 'string') known.checked = result.content;
        continue;
      }
      keep(tab, result, (entry) => entry);
    }
    scheduleSave(tabId);
  }

  async function restore(tabId: number): Promise<Map<string, Entry> | undefined> {
    const saved = await storage?.load(tabId).catch(() => undefined);
    if (!saved) return undefined;
    const tab = touch(tabId);
    for (const [key, entry] of saved) tab.set(key, entry);
    return tab;
  }

  /**
   * The summary request rebuilt from what the extension emitted: results the page named by `key` come back as the extension's own copies (a key it never
   * sent is dropped), with text only from the right place. Null when nothing is left to summarize.
   */
  async function resolve(tabId: number, request: SummaryRequest): Promise<SummaryRequest | null> {
    const tab = tabs.get(tabId) ?? (await restore(tabId));
    if (!tab) return null;
    const results: FusedResult[] = [];
    for (const asked of request.results) {
      const entry = tab.get(asked.key);
      if (!entry) continue;
      const result = structuredClone(entry.result);
      const text = request.reuse ? entry.checked : entry.sourceContent;
      if (text) result.content = text; else delete result.content;
      // The page can say whether the result counts (it may have put one back that the extension hid, or hidden one itself); what a hidden result
      // says about why comes from the extension's copy, or a bare marker, never from the page.
      if (asked.hidden) result.hidden = entry.result.hidden ?? { reason: 'rule', rule: '' }; else delete result.hidden;
      results.push(result);
    }
    return results.length ? { ...request, results } : null;
  }

  function forget(tabId: number): void {
    tabs.delete(tabId);
    const timer = timers.get(tabId);
    if (timer) { clearTimeout(timer); timers.delete(tabId); }
    void storage?.drop(tabId).catch(() => {});
  }

  return { record, resolve, forget };
}

export type EvidenceStore = ReturnType<typeof createEvidenceStore>;
