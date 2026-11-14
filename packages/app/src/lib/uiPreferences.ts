import { useSyncExternalStore } from 'react';
import type { PreferenceBackend } from '../host';

import { DEFAULT_UI_PREFERENCES, observedKeys, preferenceKeys, preferenceValues, readUiPreferences, storageKey, type PreferenceValues, type UiPreferences } from '@kiwi-search/protocol';
export { DEFAULT_UI_PREFERENCES, observedKeys, preferenceValues, readUiPreferences };
export type { SummaryMode, ThemePreference, UiPreferences } from '@kiwi-search/protocol';

type Snapshot = { preferences: UiPreferences; ready: boolean; error: string | null; resolvedTheme: 'light' | 'dark' };
let snapshot: Snapshot = { preferences: DEFAULT_UI_PREFERENCES, ready: false, error: null, resolvedTheme: 'light' };
const listeners = new Set<() => void>();
let initialization: Promise<void> | undefined;
let storedValues: Record<string, unknown> = {};
const changedVersions: Record<string, number> = {};
let pendingLoadChanges: Record<string, unknown> = {};
let subscribed = false;
let media: MediaQueryList | undefined;
let writes = Promise.resolve();
let backend: PreferenceBackend | undefined;

/** Where the preferences are kept. Call once before anything reads them: the extension and the website store them differently. */
export function configureUiPreferences(next: PreferenceBackend): void {
  backend = next;
}

function requireBackend(): PreferenceBackend {
  if (!backend) throw new Error('UI preferences have no backend: call configureUiPreferences() first');
  return backend;
}

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  const { theme } = snapshot.preferences;
  const resolvedTheme = theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme;
  snapshot = { ...snapshot, resolvedTheme };
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = resolvedTheme;
  listeners.forEach((listener) => listener());
}

/** Independent per-field keys keep appearance changes away from model keys/config writes. */
export function initializeUiPreferences(): Promise<void> {
  if (initialization) return initialization;
  requireBackend();
  if (!subscribed) {
    subscribed = true;
    if (typeof matchMedia !== 'undefined') {
      media = matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', () => publish({}));
    }
    publish({});
    requireBackend().subscribe((changed) => {
      for (const key of Object.keys(changed)) {
        changedVersions[key] = (changedVersions[key] ?? 0) + 1;
        if (!snapshot.ready) pendingLoadChanges[key] = changed[key];
      }
      storedValues = { ...storedValues, ...changed };
      publish({ preferences: readUiPreferences(storedValues) });
    });
  }
  initialization = requireBackend().load().then((values) => {
    storedValues = { ...values, ...pendingLoadChanges };
    publish({ preferences: readUiPreferences(storedValues), ready: true, error: null });
    pendingLoadChanges = {};
  }).catch((error: unknown) => {
    initialization = undefined;
    publish({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  });
  return initialization;
}

export function updateUiPreferences(patch: Partial<UiPreferences>): Promise<void> {
  const operation = writes.catch(() => {}).then(async () => {
    await initializeUiPreferences();
    const values = Object.fromEntries(preferenceKeys.filter((key) => key in patch).map((key) => [storageKey(key), patch[key]]));
    const versions = Object.fromEntries(Object.keys(values).map((key) => [key, changedVersions[key] ?? 0]));
    await requireBackend().save(values);
    // Storage events may already include this write and a newer edit from another page.
    for (const [key, value] of Object.entries(values)) if ((changedVersions[key] ?? 0) === versions[key]) storedValues[key] = value;
    publish({ preferences: readUiPreferences(storedValues), error: null });
  });
  writes = operation;
  return operation.catch((error: unknown) => {
    publish({ error: error instanceof Error ? error.message : String(error) });
    throw error;
  });
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => snapshot;
export function useUiPreferences() {
  return { ...useSyncExternalStore(subscribe, getSnapshot), update: updateUiPreferences };
}
export function useResolvedTheme() { return useSyncExternalStore(subscribe, getSnapshot).resolvedTheme; }

export const getUiPreferences = () => snapshot.preferences;
