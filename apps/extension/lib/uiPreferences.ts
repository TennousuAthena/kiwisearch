import { useSyncExternalStore } from 'react';
import { browser } from 'wxt/browser';

export type ThemePreference = 'system' | 'light' | 'dark';
export type SummaryMode = 'auto' | 'on-demand' | 'off';
export interface UiPreferences {
  theme: ThemePreference;
  summaryMode: SummaryMode;
  openNewTab: boolean;
  recentQueries: boolean;
}
export const DEFAULT_UI_PREFERENCES: UiPreferences = { theme: 'system', summaryMode: 'auto', openNewTab: true, recentQueries: true };
const keys = Object.keys(DEFAULT_UI_PREFERENCES) as (keyof UiPreferences)[];
const storageKey = (key: keyof UiPreferences) => `ui:${key}`;
const observedKeys = [...keys.map(storageKey), 'config'];

function legacySummaryEnabled(config: unknown): boolean {
  if (!config || typeof config !== 'object' || !('summary' in config)) return true;
  const summary = config.summary;
  return !summary || typeof summary !== 'object' || !('enabled' in summary) || summary.enabled !== false;
}

/** Retain only the compatibility bit from config, never its model keys or other fields. */
function preferenceValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(observedKeys.filter((key) => key in values).map((key) => [key,
    key === 'config' ? { summary: { enabled: legacySummaryEnabled(values[key]) } } : values[key],
  ]));
}

export function readUiPreferences(values: Record<string, unknown>): UiPreferences {
  const theme = values['ui:theme'];
  const summaryMode = values['ui:summaryMode'];
  return {
    theme: theme === 'light' || theme === 'dark' ? theme : 'system',
    summaryMode: summaryMode === 'auto' || summaryMode === 'on-demand' || summaryMode === 'off' ? summaryMode
      : legacySummaryEnabled(values.config) ? 'auto' : 'off',
    openNewTab: typeof values['ui:openNewTab'] === 'boolean' ? values['ui:openNewTab'] : true,
    recentQueries: typeof values['ui:recentQueries'] === 'boolean' ? values['ui:recentQueries'] : true,
  };
}

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
  if (!subscribed) {
    subscribed = true;
    if (typeof matchMedia !== 'undefined') {
      media = matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', () => publish({}));
    }
    publish({});
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !observedKeys.some((key) => key in changes)) return;
      const changed = preferenceValues(Object.fromEntries(observedKeys.filter((key) => key in changes).map((key) => [key, changes[key].newValue])));
      for (const key of Object.keys(changed)) {
        changedVersions[key] = (changedVersions[key] ?? 0) + 1;
        if (!snapshot.ready) pendingLoadChanges[key] = changed[key];
      }
      storedValues = { ...storedValues, ...changed };
      publish({ preferences: readUiPreferences(storedValues) });
    });
  }
  initialization = browser.storage.local.get(observedKeys).then((values) => {
    storedValues = { ...preferenceValues(values), ...pendingLoadChanges };
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
    const values = Object.fromEntries(keys.filter((key) => key in patch).map((key) => [storageKey(key), patch[key]]));
    const versions = Object.fromEntries(Object.keys(values).map((key) => [key, changedVersions[key] ?? 0]));
    await browser.storage.local.set(values);
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
