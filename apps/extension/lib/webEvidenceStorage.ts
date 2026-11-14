import { browser } from 'wxt/browser';
import type { EvidenceEntries, EvidenceStorage } from './webEvidence';

const key = (tabId: number) => `webEvidence:${tabId}`;

/**
 * Keeps each tab's evidence in session storage, so a service worker that was stopped while the page was being read still knows what it sent. Session
 * storage lives in memory and is gone when the browser closes. Where the browser has none, the evidence lives only as long as the worker does.
 */
export function sessionEvidenceStorage(): EvidenceStorage | undefined {
  const session = browser.storage?.session;
  if (!session) return undefined;
  return {
    load: async (tabId) => (await session.get(key(tabId)))[key(tabId)] as EvidenceEntries | undefined,
    save: (tabId, entries) => session.set({ [key(tabId)]: entries }),
    drop: (tabId) => session.remove(key(tabId)),
  };
}
