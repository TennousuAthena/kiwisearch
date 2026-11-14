import { createI18n, resolveLocale } from './runtime';
import { zhCN } from './zh-CN';

export { formatMessage, parseRich, resolveLocale, type ParamValue, type Params, type RichPart, type Tags } from './runtime';

/** The messages as the source language writes them; the type of every key, and of the placeholders each takes. */
export type Catalog = typeof zhCN;
export type MessageKey = keyof Catalog & string;

/**
 * Other languages go in here as `{ 'en': en, … }`, each a `Partial<Record<MessageKey, string>>`. Whatever one leaves out is
 * read from Chinese. `test/i18n.test.ts` checks that a translation keeps the placeholders of the text it translates.
 */
export const i18n = createI18n(zhCN, 'zh-CN', {});

/** `t('newtab.status.results', { count: 3 })`. A key or a placeholder that does not exist is a type error. */
export const t = i18n.t;
/** A message as written, for text with braces or angle brackets in it, and for `rich` in `rich.tsx`. */
export const raw = i18n.raw;
export const getLocale = i18n.getLocale;
export const setLocale = i18n.setLocale;

/**
 * Picks the interface language from the browser's preferred languages and sets it. Call once when a page or the service
 * worker starts, before anything is rendered. With one language available this changes nothing.
 */
export function initLocale(languages: readonly string[] = globalThis.navigator?.languages ?? []): string {
  i18n.setLocale(resolveLocale(languages, i18n.locales, i18n.sourceLocale));
  return i18n.getLocale();
}
