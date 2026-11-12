import { RRF_K, absorb, type Weights } from './fusion';
import { foldHan } from './han';
import type { FusedResult } from './types';

/**
 * Wikipedia has an edition per language, and for Chinese a lot of them: Mandarin in two scripts (`zh`, served in a variant: Simplified
 * `zh-cn` / `zh-hans`, Traditional `zh-tw` / `zh-hk` / `zh-hant`), Cantonese (`zh-yue`), Wu (`wuu`), Classical Chinese (`zh-classical`), Min Nan
 * (`zh-min-nan`), Gan, Hakka, Eastern Min. A search engine returns whichever it indexed, often several of one article, so the same page
 * turns up as `/zh-cn/X`, `/zh-tw/X`, `zh.m.` and on a sibling edition. `foldWikipediaEditions` keeps the one in the user's language.
 *
 * Two articles are the same one when their titles are the same after Traditional characters are turned into Simplified ones. That is
 * all the offline signal there is: an article called "计算机" on one edition and "電腦" on another is not recognized (it would take
 * Wikidata), so those stay as two results.
 */

/** Variants the Chinese edition (`zh`) is served in, by the script they are written in. */
const SCRIPT_OF_VARIANT: Record<string, 'hans' | 'hant'> = {
  'zh-hans': 'hans',
  'zh-cn': 'hans',
  'zh-sg': 'hans',
  'zh-my': 'hans',
  'zh-hant': 'hant',
  'zh-tw': 'hant',
  'zh-hk': 'hant',
  'zh-mo': 'hant',
};

/** Editions whose subdomain is not their language code. */
const EDITION_OF_LANGUAGE: Record<string, string> = { yue: 'zh-yue', lzh: 'zh-classical', nan: 'zh-min-nan' };

/** The language codes of Chinese, Mandarin and the Chinese languages that have a Wikipedia. */
const CHINESE = new Set(['zh', 'cmn', 'yue', 'wuu', 'lzh', 'nan', 'gan', 'hak', 'cdo']);

const split = (tag: string) => tag.trim().toLowerCase().replace(/_/g, '-').split('-');

/** Whether a language tag is one of the Chinese languages (`zh-CN`, `zh-Hant`, `yue`, `wuu`, …): who the fold is on for by default. */
export function isChineseLanguage(tag: string | undefined): boolean {
  return !!tag && CHINESE.has(split(tag)[0]);
}

/**
 * Whether the fold is on: what the user chose, and when they never chose, on for Chinese browsers. It is a setting nobody has to
 * go looking for, since the Chinese editions are where one article turns up the most times.
 */
export function wikipediaFoldEnabled(setting: boolean | undefined, browserLanguage: string | undefined): boolean {
  return setting ?? isChineseLanguage(browserLanguage);
}

/** The edition a user reads, and for the Chinese edition the variant: what `foldWikipediaEditions` keeps. */
export interface WikipediaTarget {
  /** Subdomain of the edition: `zh`, `en`, `zh-yue`, `zh-classical`, `wuu`, … */
  edition: string;
  /** Script of the variant the user reads, for the `zh` edition. Without one every variant is as good as the next. */
  script?: 'hans' | 'hant';
  /** The variant itself (`zh-cn`, `zh-tw`, `zh-hans`, …) when the tag names one. */
  variant?: string;
}

/** The edition for a browser language tag; undefined when there is no language to go by. */
export function wikipediaTarget(tag: string | undefined): WikipediaTarget | undefined {
  if (!tag?.trim()) return undefined;
  const parts = split(tag);
  const head = parts.slice(0, 2).join('-');
  // `zh-yue`, `zh-classical` and `zh-min-nan` are how the editions themselves are named; the script or country follows `zh` otherwise.
  if (head === 'zh-yue' || head === 'zh-classical') return { edition: head };
  if (parts.slice(0, 3).join('-') === 'zh-min-nan') return { edition: 'zh-min-nan' };
  const [primary, ...rest] = parts;
  if (primary === 'zh' || primary === 'cmn') {
    // The country says more than the script (`zh-Hant-TW` is Taiwan's), so the last subtag that names a variant wins.
    const variant = rest.map((part) => `zh-${part}`).reverse().find((candidate) => candidate in SCRIPT_OF_VARIANT);
    return variant ? { edition: 'zh', script: SCRIPT_OF_VARIANT[variant], variant } : { edition: 'zh' };
  }
  return { edition: EDITION_OF_LANGUAGE[primary] ?? primary };
}

/** What a Wikipedia article address says. */
export interface WikipediaPage {
  edition: string;
  /** The variant named in the address (`/zh-tw/X`, `?variant=zh-tw`, a `zh-tw.` host), when it names one. */
  variant?: string;
  /** The article's title as the address spells it, underscores read as spaces. */
  title: string;
}

/** `zh.wikipedia.org/wiki/X`, `zh.m.wikipedia.org/zh-tw/X`, `…/w/index.php?title=X&variant=zh-hk` and the like: undefined for anything that is not an article. */
export function parseWikipediaUrl(raw: string): WikipediaPage | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const label = url.hostname.toLowerCase().match(/^([a-z][a-z0-9-]*?)(?:\.m)?\.wikipedia\.org$/)?.[1];
  if (!label || label === 'www') return undefined;
  // The old per-variant hosts (`zh-tw.wikipedia.org`) belong to the Chinese edition.
  const hostVariant = label in SCRIPT_OF_VARIANT ? label : undefined;
  const edition = hostVariant ? 'zh' : label;

  let variant = hostVariant;
  let title: string | undefined;
  const path = url.pathname;
  const article = path.match(/^\/wiki\/(.+)$/);
  const prefixed = edition === 'zh' ? path.match(/^\/(zh|zh-[a-z]+)\/(.+)$/) : null;
  if (article) {
    title = article[1];
  } else if (prefixed && (prefixed[1] === 'zh' || prefixed[1] in SCRIPT_OF_VARIANT)) {
    if (prefixed[1] !== 'zh') variant = prefixed[1];
    title = prefixed[2];
  } else if (/^\/(?:w\/)?index\.php$/.test(path)) {
    title = url.searchParams.get('title') ?? undefined;
  }
  const asked = url.searchParams.get('variant')?.toLowerCase();
  if (edition === 'zh' && asked && asked in SCRIPT_OF_VARIANT) variant = asked;
  if (!title) return undefined;
  try {
    title = decodeURIComponent(title);
  } catch {
    // keep it as written
  }
  title = title.replace(/_/g, ' ').trim();
  return title ? { edition, ...(variant ? { variant } : {}), title } : undefined;
}

/** Titles compare equal across scripts and editions: width and case folded, Traditional turned into Simplified, runs of spaces made one. */
export function wikipediaTitleKey(title: string): string {
  return foldHan(title.normalize('NFKC').toLowerCase()).replace(/\s+/g, ' ').trim();
}

/** Lower is better: the variant the user reads, or none named (the site then picks one from the browser's Accept-Language), then the same script, then the other one. */
function variantRank(variant: string | undefined, target: WikipediaTarget): number {
  if (!target.script || !variant || variant === target.variant) return 0;
  return SCRIPT_OF_VARIANT[variant] === target.script ? 1 : 2;
}

interface Entry {
  /** Where the result stands in the list; for a collapsed copy, the place of the best-ranked one. */
  index: number;
  result: FusedResult;
  page: WikipediaPage;
}

const wikipediaHost = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace('.m.', '.');
  } catch {
    return url;
  }
};

function clone(result: FusedResult): FusedResult {
  return { ...result, sources: result.sources.map((source) => ({ ...source })), meta: { ...result.meta } };
}

/** The member that stands for the rest, and what it stands for: its score and, for a late one, its lateness, are those of the best of them. */
function merge(survivor: FusedResult, others: FusedResult[], all: FusedResult[], weights: Weights): FusedResult {
  const merged = clone(survivor);
  for (const other of others) absorb(merged, other, weights, RRF_K);
  merged.rrfScore = Math.max(merged.rrfScore, ...all.map((result) => result.rrfScore));
  merged.score = Math.max(...all.map((result) => result.score));
  if (merged.late && all.some((result) => !result.late)) delete merged.late;
  return merged;
}

/**
 * One result per Wikipedia article, in the user's language.
 *
 * Results whose address is a Wikipedia article are grouped by title (`wikipediaTitleKey`). In a group:
 *   - copies on one edition (`/zh-cn/X`, `/zh-tw/X`, `/wiki/X`, the mobile host) are the same page and become one, the engines that
 *     returned them counted together. On the user's edition the copy in their variant stays (or one with no variant named, which the
 *     site serves in their variant), then the best ranked;
 *   - when the user's edition is in the group, the copies on the other editions (Cantonese, Wu, Classical, English, …) fold into it and are
 *     listed under it as `reprints`, the way a copied article is. When it is not, they are left alone: there is no result in the user's
 *     language to prefer, and showing none of them would lose the article.
 *
 * A Chinese article whose address names a variant in the other script than the user reads (`/zh-tw/X` for a Simplified reader) gets the
 * plain address (`/wiki/X`), whether or not it was folded: without a variant in the address the site serves the reader's own, from the
 * browser's Accept-Language (checked against zh.wikipedia.org on 2026-11-12: Simplified for `zh-CN`, Traditional for `zh-TW` and `zh-HK`).
 * Nothing else about a kept result changes. The order of the list is kept; a folded result takes the place of its best-ranked member and
 * the best of their scores. Folding the output again changes nothing, so a late source can be merged and folded once more.
 */
export function foldWikipediaEditions(results: FusedResult[], target: WikipediaTarget | undefined, weights: Weights = {}): FusedResult[] {
  if (!target) return results;
  const groups = new Map<string, Entry[]>();
  results.forEach((result, index) => {
    if (result.image || result.video || result.note) return;
    const page = parseWikipediaUrl(result.url);
    if (!page) return;
    const key = wikipediaTitleKey(page.title);
    const group = groups.get(key);
    if (group) group.push({ index, result, page });
    else groups.set(key, [{ index, result, page }]);
  });

  const replace = new Map<number, FusedResult>();
  const drop = new Set<number>();
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    // One copy per edition.
    const perEdition = new Map<string, Entry[]>();
    for (const entry of entries) perEdition.set(entry.page.edition, [...(perEdition.get(entry.page.edition) ?? []), entry]);
    const slots: Entry[] = [];
    for (const [edition, copies] of perEdition) {
      if (copies.length === 1) {
        slots.push(copies[0]);
        continue;
      }
      const own = edition === target.edition;
      const ranked = [...copies].sort((a, b) => (own ? variantRank(a.page.variant, target) - variantRank(b.page.variant, target) : 0) || a.index - b.index);
      const [best, ...rest] = ranked;
      slots.push({
        index: Math.min(...copies.map((copy) => copy.index)),
        page: best.page,
        result: merge(best.result, rest.map((copy) => copy.result), copies.map((copy) => copy.result), weights),
      });
    }
    // The other editions fold into the user's, when it is there.
    const own = slots.find((slot) => slot.page.edition === target.edition);
    const kept: Entry[] = own && slots.length > 1 ? [foldInto(own, slots.filter((slot) => slot !== own))] : slots;
    if (kept.length === entries.length) continue;
    for (const entry of entries) drop.add(entry.index);
    for (const slot of kept) {
      drop.delete(slot.index);
      replace.set(slot.index, slot.result);
    }
  }
  let changed = drop.size > 0;
  const out: FusedResult[] = [];
  results.forEach((result, index) => {
    if (drop.has(index)) return;
    let next = replace.get(index) ?? result;
    const plain = otherScriptVariant(next, target) ? plainArticleUrl(next.url) : undefined;
    if (plain && plain !== next.url) next = { ...next, url: plain };
    if (next !== result) changed = true;
    out.push(next);
  });
  return changed ? out : results;
}

/** Whether the result is a Chinese article whose address names a variant written in the other script than the one the user reads. */
function otherScriptVariant(result: FusedResult, target: WikipediaTarget): boolean {
  if (target.edition !== 'zh' || !target.script || result.image || result.video || result.note) return false;
  const variant = parseWikipediaUrl(result.url)?.variant;
  return !!variant && SCRIPT_OF_VARIANT[variant] !== target.script;
}

/** The address of a Chinese article without the variant it names: `/zh-tw/X`, `?variant=zh-tw` and an old `zh-tw.` host all go. */
function plainArticleUrl(raw: string): string {
  const url = new URL(raw);
  url.hostname = url.hostname.replace(/^zh-[a-z]+(?=(?:\.m)?\.wikipedia\.org$)/, (label) => (label in SCRIPT_OF_VARIANT ? 'zh' : label));
  url.pathname = url.pathname.replace(/^\/(zh-[a-z]+)\//, (prefix, variant: string) => (variant in SCRIPT_OF_VARIANT ? '/wiki/' : prefix));
  if (url.searchParams.has('variant')) url.searchParams.delete('variant');
  return url.toString();
}

/** `own` with the other editions' copies listed under it, standing in the place of the best-ranked of them all. */
function foldInto(own: Entry, others: Entry[]): Entry {
  const all = [own, ...others];
  const result = clone(own.result);
  result.rrfScore = Math.max(...all.map((slot) => slot.result.rrfScore));
  result.score = Math.max(...all.map((slot) => slot.result.score));
  if (result.late && all.some((slot) => !slot.result.late)) delete result.late;
  const seen = new Set((result.reprints ?? []).map((copy) => copy.url));
  result.reprints = [
    ...(result.reprints ?? []),
    ...others.filter((slot) => !seen.has(slot.result.url)).map((slot) => ({ url: slot.result.url, host: wikipediaHost(slot.result.url) })),
  ];
  return { index: Math.min(...all.map((slot) => slot.index)), page: own.page, result };
}
