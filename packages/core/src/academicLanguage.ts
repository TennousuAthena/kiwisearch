import type { AcademicLanguage, FusedResult } from './types';

/**
 * Limiting an academic search to a language. OpenAlex, PubMed, Europe PMC and Google Scholar are asked for that language
 * themselves; the other sources cannot be (Crossref has no language filter, DBLP and arXiv are English anyway, and the
 * parameters of Baidu Scholar, CNKI and Web of Science are not known), and even a filter the source applies is only as good as
 * its language tag (OpenAlex tags some Chinese-titled papers `ja`, and some English titles in Chinese journals `zh`). So every
 * result is also checked by its title, here, and one that fails is hidden, not dropped: the page lists it with the reason.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN = /[A-Za-z]/;

/**
 * Whether a title reads as English: no Chinese, Japanese or Korean characters, and some Latin letters. It cannot tell English
 * from another language written in Latin letters (German, Spanish), and a title that quotes a Chinese term is not English by this test.
 */
export function isEnglishTitle(title: string): boolean {
  return LATIN.test(title) && !CJK.test(title);
}

export function matchesAcademicLanguage(title: string, language: AcademicLanguage | undefined): boolean {
  return language !== 'en' || isEnglishTitle(title);
}

/** The text has Chinese, Japanese or Korean characters in it: a query like that finds little in English-language indexes. */
export function hasCjk(text: string): boolean {
  return CJK.test(text);
}

/**
 * Hides the results whose title is not in `language` and moves them behind the others, each group keeping its order. A result
 * that is already hidden for another reason keeps that reason. With no limit the list comes back as it is, so this is safe to
 * repeat on every merge.
 */
export function applyAcademicLanguage(results: FusedResult[], language: AcademicLanguage | undefined): FusedResult[] {
  if (language !== 'en') return results;
  let changed = false;
  const marked = results.map((result): FusedResult => {
    if (result.hidden || isEnglishTitle(result.title)) return result;
    changed = true;
    return { ...result, hidden: { reason: 'language' } };
  });
  if (!changed) return results;
  return [...marked.filter((r) => !r.hidden), ...marked.filter((r) => r.hidden)];
}
