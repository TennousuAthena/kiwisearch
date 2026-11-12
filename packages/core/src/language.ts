import type { FusionConfig } from './types';

/**
 * The language of the AI overview. The setting `summary.language` is one of:
 *   - `browser` (the default): the browser's first language, which the caller passes in as `Env.browserLanguage`;
 *   - `auto`: the language of the query, which is left to the model ("answer in the language of the query");
 *   - `custom`: whatever the user wrote in `summary.languageCustom` ("Italiano", "文言文");
 *   - a tag from `OVERVIEW_LANGUAGES` (`zh-CN`, `ja`, …).
 * `overviewLanguage` turns it into the name the prompt uses, or nothing for `auto`.
 */

/** Languages the settings page offers by name, each written in itself, as language pickers do. `tag` is BCP 47. */
export const OVERVIEW_LANGUAGES: { tag: string; label: string }[] = [
  { tag: 'zh-CN', label: '简体中文' },
  { tag: 'zh-TW', label: '繁體中文' },
  { tag: 'en', label: 'English' },
  { tag: 'ja', label: '日本語' },
  { tag: 'ko', label: '한국어' },
  { tag: 'es', label: 'Español' },
  { tag: 'fr', label: 'Français' },
  { tag: 'de', label: 'Deutsch' },
  { tag: 'pt-BR', label: 'Português (Brasil)' },
  { tag: 'ru', label: 'Русский' },
  { tag: 'it', label: 'Italiano' },
  { tag: 'ar', label: 'العربية' },
  { tag: 'hi', label: 'हिन्दी' },
  { tag: 'id', label: 'Bahasa Indonesia' },
  { tag: 'vi', label: 'Tiếng Việt' },
  { tag: 'th', label: 'ไทย' },
  { tag: 'tr', label: 'Türkçe' },
  { tag: 'nl', label: 'Nederlands' },
  { tag: 'pl', label: 'Polski' },
  { tag: 'uk', label: 'Українська' },
];

const MAX_CUSTOM = 40;

/** Chinese needs the script, not the country: Traditional for Taiwan, Hong Kong, Macau and `Hant`, Simplified for everything else. */
function chineseName(tag: string): string {
  return /(^|-)(hant|tw|hk|mo)(-|$)/i.test(tag) ? 'Traditional Chinese' : 'Simplified Chinese';
}

/** The English name of a language tag as a prompt would say it ("Brazilian Portuguese", "Japanese"); undefined when it is not a language tag. */
export function languageName(tag: string | undefined): string | undefined {
  const cleaned = tag?.trim().replace(/_/g, '-');
  if (!cleaned || cleaned.length > 35) return undefined;
  if (/^zh(-|$)/i.test(cleaned)) return chineseName(cleaned);
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(cleaned);
    // An unknown code comes back as itself.
    return name && name.toLowerCase() !== cleaned.toLowerCase() ? name : undefined;
  } catch {
    return undefined;
  }
}

/** The entry of `OVERVIEW_LANGUAGES` that a tag is, for showing it by name: an exact match, a Chinese script match, or the same bare language. */
export function overviewLanguageFor(tag: string | undefined): { tag: string; label: string } | undefined {
  const cleaned = tag?.trim().replace(/_/g, '-').toLowerCase();
  if (!cleaned) return undefined;
  if (/^zh(-|$)/.test(cleaned)) return OVERVIEW_LANGUAGES.find((l) => l.tag === (chineseName(cleaned) === 'Traditional Chinese' ? 'zh-TW' : 'zh-CN'));
  return OVERVIEW_LANGUAGES.find((l) => l.tag.toLowerCase() === cleaned) ?? OVERVIEW_LANGUAGES.find((l) => l.tag.toLowerCase() === cleaned.split('-')[0]);
}

/** A language the user typed: one line, letters, digits and a little punctuation, at most 40 characters. A code like `fr` or `pt-BR` is read as one. */
export function customLanguage(text: string | undefined): string | undefined {
  const cleaned = (text ?? '')
    .replace(/[^\p{L}\p{N}\p{M}\s()'’.,/_-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CUSTOM)
    .trim();
  return cleaned ? languageName(cleaned) ?? cleaned : undefined;
}

/**
 * What to tell the model to write the overview in: a language name, or undefined to leave it to the model to answer in the language
 * of the query (`auto`, and also the fallback when the browser's language is unknown or the setting is not understood).
 */
export function overviewLanguage(summary: Pick<FusionConfig['summary'], 'language' | 'languageCustom'>, browserLanguage?: string): string | undefined {
  const setting = summary.language ?? 'browser';
  if (setting === 'auto') return undefined;
  if (setting === 'custom') return customLanguage(summary.languageCustom);
  return languageName(setting === 'browser' ? browserLanguage : setting);
}
