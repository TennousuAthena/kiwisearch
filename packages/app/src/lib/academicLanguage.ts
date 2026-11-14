import type { AcademicLanguage } from '@kiwi-search/core';

export type { AcademicLanguage };

/** A stored value as a language; anything that is not a known value is "no limit". Mirrors `isAcademicLanguage` in core, which this page avoids importing. */
export function parseAcademicLanguage(value: unknown): AcademicLanguage {
  return value === 'en' ? 'en' : 'any';
}
