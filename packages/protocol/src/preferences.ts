export type PreferenceValues = Record<string, unknown>;

export type ThemePreference = 'system' | 'light' | 'dark';
export type SummaryMode = 'auto' | 'on-demand' | 'off';
export interface UiPreferences {
  theme: ThemePreference;
  summaryMode: SummaryMode;
  openNewTab: boolean;
  recentQueries: boolean;
}
export const DEFAULT_UI_PREFERENCES: UiPreferences = { theme: 'system', summaryMode: 'auto', openNewTab: true, recentQueries: true };
export const preferenceKeys = Object.keys(DEFAULT_UI_PREFERENCES) as (keyof UiPreferences)[];
export const storageKey = (key: keyof UiPreferences) => `ui:${key}`;
/** The stored keys the interface reads: the preferences, and `config` only for the old on/off switch of the summary. */
export const observedKeys = [...preferenceKeys.map(storageKey), 'config'];

function legacySummaryEnabled(config: unknown): boolean {
  if (!config || typeof config !== 'object' || !('summary' in config)) return true;
  const summary = config.summary;
  return !summary || typeof summary !== 'object' || !('enabled' in summary) || summary.enabled !== false;
}

/** Retain only the compatibility bit from config, never its model keys or other fields. */
export function preferenceValues(values: PreferenceValues): PreferenceValues {
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


/**
 * What a website may write: only the four interface preferences, each with a valid value. Anything else (another key, a wrong type, an
 * unknown value) makes the whole save invalid, so a page cannot use this to reach `config` or any other stored key.
 */
export function parsePreferenceSave(raw: unknown): PreferenceValues | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (!entries.length || entries.length > preferenceKeys.length) return null;
  const out: PreferenceValues = {};
  for (const [key, value] of entries) {
    if (key === storageKey('theme') && (value === 'system' || value === 'light' || value === 'dark')) out[key] = value;
    else if (key === storageKey('summaryMode') && (value === 'auto' || value === 'on-demand' || value === 'off')) out[key] = value;
    else if ((key === storageKey('openNewTab') || key === storageKey('recentQueries')) && typeof value === 'boolean') out[key] = value;
    else return null;
  }
  return out;
}
