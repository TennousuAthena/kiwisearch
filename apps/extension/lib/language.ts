import { languageName, overviewLanguageFor } from '@kiwi-search/core';
import { getLocale, t } from '@kiwi-search/app/i18n';

/**
 * The languages Chrome's built-in model (Prompt API) accepts for output, from Chrome's documentation of it (read 2026-11-12:
 * "accepts en, ja, es, de and fr", more "in development"). Another language is not refused when a session is made without one, but it
 * can come out as English or badly, and a session that names it is refused with `NotSupportedError`.
 */
export const BUILTIN_MODEL_LANGUAGES = ['en', 'ja', 'es', 'de', 'fr'];

/** The language to use from what a browser reports: the first of its language list (the one sites are told in Accept-Language), else its display language. */
export function pickBrowserLanguage(accepted: readonly string[] | undefined, ui?: string): string | undefined {
  return accepted?.find((tag) => !!tag?.trim())?.trim() || ui?.trim() || undefined;
}

/** The browser's language as a BCP 47 tag. Works in the service worker, the options page and the new-tab page alike. */
export function browserLanguage(): string | undefined {
  const scope = globalThis as { navigator?: { languages?: readonly string[]; language?: string }; browser?: unknown; chrome?: unknown };
  const api = (scope.browser ?? scope.chrome) as { i18n?: { getUILanguage?: () => string } } | undefined;
  let ui: string | undefined;
  try {
    ui = api?.i18n?.getUILanguage?.();
  } catch {
    // Outside an extension there is no i18n.
  }
  return pickBrowserLanguage(scope.navigator?.languages?.length ? scope.navigator.languages : scope.navigator?.language ? [scope.navigator.language] : undefined, ui);
}

/** A language tag in the words of the settings page: "简体中文", "English", or a Chinese name such as "瑞典语" for one that is not offered. */
export function languageLabel(tag: string | undefined): string {
  if (!tag?.trim()) return t('options.language.unknown');
  const known = overviewLanguageFor(tag);
  if (known) return known.label;
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'language' }).of(tag.trim().replace(/_/g, '-')) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * Whether Chrome's built-in model can write in the language the setting comes to. Undefined when that cannot be told: `auto` depends on
 * the query, the browser may say nothing, and a custom language written as a name ("Deutsch") rather than a code is not looked up.
 */
export function builtinModelWrites(setting: string, custom: string, browserTag: string | undefined): boolean | undefined {
  if (setting === 'auto') return undefined;
  const tag = setting === 'browser' ? browserTag : setting === 'custom' ? (languageName(custom.trim()) ? custom.trim() : undefined) : setting;
  if (!tag) return undefined;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return BUILTIN_MODEL_LANGUAGES.includes(primary);
}
