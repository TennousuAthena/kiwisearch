import {
  createRateLimiter, isWebMethod, parseAcademicLanguageSaveParams, parseDomainPreferenceParams, parseFaviconParams, parseFocusWorkerParams,
  parseOpenLocalParams, parseOpenOptionsParams, parsePrefsSaveParams, parseUndoParams, WEB_CAPS,
  type HelloReply, type PreferenceValues,
} from '@kiwi-search/protocol';
import type { SearchMode } from '@kiwi-search/core';
import type { SettingsUpdate, SettingsUpdateResponse } from './configUpdates';
import type { UiSource } from './uiSource';
import { isWebSitePage, type WebSite } from './webOrigins';

/** What the service worker needs to answer a website. Everything outside the checks lives behind this, so the checks can be tested. */
export interface WebBridgeDeps {
  extensionId: string;
  version: string;
  sites: readonly WebSite[];
  uiSource(): Promise<UiSource>;
  favicon(host: string): Promise<string | null>;
  focusWorker(source: string): Promise<boolean>;
  updateSettings(message: SettingsUpdate): Promise<SettingsUpdateResponse>;
  loadPreferences(): Promise<PreferenceValues>;
  savePreferences(values: PreferenceValues): Promise<void>;
  loadAcademicLanguage(): Promise<'any' | 'en'>;
  saveAcademicLanguage(language: 'any' | 'en'): Promise<void>;
  /** Shows the search in the extension's own interface in this tab. */
  openLocal(tabId: number, query: string, mode: SearchMode): Promise<void>;
  openOptions(section?: string): Promise<void>;
  now?(): number;
}

export interface WebSender { id?: string; url?: string; tab?: { id?: number }; frameId?: number }

/** An error a website gets to see: a short code and a message, nothing from the inside. */
export class WebRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WebRequestError';
  }
}

/**
 * True for a message that came from our content script in the top frame of the search page of the website. The content script runs only
 * on that page, but the service worker does not rely on that: the sender's identity, frame, origin and path are checked here as well.
 */
export function isWebBridgeSender(sender: WebSender | undefined, extensionId: string, sites: readonly WebSite[]): boolean {
  if (!sender || sender.id !== extensionId || !sender.url || sender.tab?.id === undefined || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  try { return isWebSitePage(new URL(sender.url), sites); } catch { return false; }
}

const WRITES_PER_MINUTE = 30;

export function createWebBridgeHandlers(deps: WebBridgeDeps) {
  const allowWrite = createRateLimiter(WRITES_PER_MINUTE, 60_000, deps.now);
  const isSender = (sender: WebSender | undefined): sender is WebSender & { tab: { id: number } } => isWebBridgeSender(sender, deps.extensionId, deps.sites);

  /** The page may use the extension only from a web sender, and only while the extension is set to use the website. */
  async function allowed(sender: WebSender | undefined): Promise<boolean> {
    return isSender(sender) && (await deps.uiSource()) === 'site';
  }

  async function hello(sender: WebSender | undefined): Promise<HelloReply> {
    if (!isSender(sender)) throw new WebRequestError('forbidden', 'Not a page of the website');
    if ((await deps.uiSource()) === 'local') return { state: 'disabled' };
    return { state: 'ok', ext: deps.version, caps: [...WEB_CAPS] };
  }

  async function request(method: unknown, params: unknown, sender: WebSender | undefined): Promise<unknown> {
    if (!(await allowed(sender))) throw new WebRequestError('forbidden', 'The extension does not take requests from this page');
    const tabId = (sender as { tab: { id: number } }).tab.id;
    if (!isWebMethod(method)) throw new WebRequestError('unknown_method', 'Unknown request');
    const invalid = () => new WebRequestError('invalid', 'The request does not have the expected form');
    // Writes are limited per tab; reads are cheap and bounded by the relay's counts.
    const writes = ['domainPreference', 'undoDomainPreference', 'prefs.save', 'academicLanguage.save', 'openOptions'];
    if (writes.includes(method) && !allowWrite(`w:${tabId}`)) throw new WebRequestError('rate_limited', 'Too many requests');

    switch (method) {
      case 'favicon': {
        const p = parseFaviconParams(params); if (!p) throw invalid();
        return { src: await deps.favicon(p.host) };
      }
      case 'focusWorker': {
        const p = parseFocusWorkerParams(params); if (!p) throw invalid();
        return { ok: await deps.focusWorker(p.source) };
      }
      case 'domainPreference': {
        const p = parseDomainPreferenceParams(params); if (!p) throw invalid();
        // The message is built here from checked fields. A page cannot make it carry a settings patch.
        const result = await deps.updateSettings({ type: 'kiwi:update-settings', action: p.action, domain: p.domain });
        if (!result.ok) throw new WebRequestError('failed', 'The change was not saved');
        return { undo: result.undo };
      }
      case 'undoDomainPreference': {
        const p = parseUndoParams(params); if (!p) throw invalid();
        const result = await deps.updateSettings({ type: 'kiwi:update-settings', undo: p.undo });
        if (!result.ok) throw new WebRequestError('failed', 'The change was not saved');
        return { restored: result.restored === true };
      }
      case 'prefs.load': return { values: await deps.loadPreferences() };
      case 'prefs.save': {
        const p = parsePrefsSaveParams(params); if (!p) throw invalid();
        await deps.savePreferences(p.values);
        return {};
      }
      case 'academicLanguage.load': return { language: await deps.loadAcademicLanguage() };
      case 'academicLanguage.save': {
        const p = parseAcademicLanguageSaveParams(params); if (!p) throw invalid();
        await deps.saveAcademicLanguage(p.language);
        return {};
      }
      case 'openLocal': {
        const p = parseOpenLocalParams(params); if (!p) throw invalid();
        await deps.openLocal(tabId, p.query, p.mode);
        return {};
      }
      case 'openOptions': {
        const p = parseOpenOptionsParams(params); if (!p) throw invalid();
        await deps.openOptions(p.section);
        return {};
      }
    }
  }

  return { allowed, hello, request, isSender };
}

export type WebBridgeHandlers = ReturnType<typeof createWebBridgeHandlers>;

/** The envelope a request travels back in through `runtime.sendMessage`. */
export type WebReply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

export async function answer(work: Promise<unknown>): Promise<WebReply> {
  try { return { ok: true, result: await work }; } catch (error) {
    if (error instanceof WebRequestError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: 'failed', message: 'The extension could not complete the request' } };
  }
}
