import type { AcademicLanguage } from '@kiwi-search/core';
import { browser } from 'wxt/browser';

export type { AcademicLanguage };

/** What the academic tab last chose. A preference of the page, kept apart from `config` so the settings page, which saves the whole config, can't overwrite it. */
const KEY = 'academicLanguage';

/** A stored value as a language; anything that is not a known value is "no limit". Mirrors `isAcademicLanguage` in core, which this page avoids importing. */
export function parseAcademicLanguage(value: unknown): AcademicLanguage {
  return value === 'en' ? 'en' : 'any';
}

export async function loadAcademicLanguage(): Promise<AcademicLanguage> {
  const stored = await browser.storage.local.get(KEY);
  return parseAcademicLanguage(stored[KEY]);
}

export async function saveAcademicLanguage(language: AcademicLanguage): Promise<void> {
  await browser.storage.local.set({ [KEY]: language });
}
