import type { AcademicLanguage } from '@kiwi-search/core';
import type { DomainPreferenceAction, DomainPreferenceUndo } from '@kiwi-search/protocol';
import type { SessionPort } from './lib/searchSessionController';

/** Stored interface preferences, keyed as they are stored (`ui:theme`, …). Already reduced to what the page may see. */
export type PreferenceValues = Record<string, unknown>;

export interface PreferenceBackend {
  load(): Promise<PreferenceValues>;
  save(values: PreferenceValues): Promise<void>;
  /** `listener` gets only the keys that changed, for changes made elsewhere (another page, the settings page). */
  subscribe(listener: (changed: PreferenceValues) => void): void;
}

/**
 * Everything the search interface needs from outside itself. The extension's own page implements it with the `browser.*`
 * calls, the website with the bridge protocol; the interface never calls either directly.
 */
export interface KiwiHost {
  /** Opens a search or summary stream. Same shape as a `runtime.Port`. */
  connect(name: 'search' | 'summary'): SessionPort;
  /** The icon of a site as an image address, or null when there is none. */
  favicon(host: string): Promise<string | null>;
  /** Brings the worker tab of a source to the front (to solve a captcha or sign in). */
  focusWorker(source: string): void;
  /** Blocks, boosts or clears a site. Resolves with what is needed to undo it. */
  domainPreference(action: DomainPreferenceAction, domain: string): Promise<DomainPreferenceUndo>;
  /** False means a newer action changed the site since. */
  undoDomainPreference(undo: DomainPreferenceUndo): Promise<boolean>;
  preferences: PreferenceBackend;
  academicLanguage: { load(): Promise<AcademicLanguage>; save(language: AcademicLanguage): Promise<void> };
  /** Where the logo links to: the start page of this interface. */
  homeUrl: string;
  /** The settings page, for the links that lead there. */
  optionsUrl: string;
}
