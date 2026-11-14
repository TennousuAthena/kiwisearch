import type { FusedResult, HiddenReason, NewsOptions, SearchMode, VerifiedLandmark } from '@kiwi-search/core';
import { t, type MessageKey } from './i18n';

export function splitResults(results: FusedResult[]): { visible: FusedResult[]; hidden: FusedResult[] } {
  return { visible: results.filter((r) => !r.hidden), hidden: results.filter((r) => r.hidden) };
}

export function hiddenLabel(hidden: HiddenReason): string {
  switch (hidden.reason) {
    case 'junk':
      return t('newtab.hidden.junk');
    case 'irrelevant':
      return t('newtab.hidden.irrelevant');
    case 'rule':
      return t('newtab.hidden.rule', { rule: hidden.rule });
    case 'blocked':
      return hidden.list ? t('newtab.hidden.blockedList', { list: hidden.list }) : t('newtab.hidden.blocked');
    case 'language':
      return t('newtab.hidden.language');
    case 'time':
      return t(`newtab.hidden.time.${hidden.detail}`);
    case 'unresolved':
      return t('newtab.hidden.unresolved');
  }
}

/** The text has Chinese, Japanese or Korean characters in it. Mirrors `hasCjk` in core, which this bundle avoids importing. */
export const hasCjk = (text: string): boolean => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Host whose icon heads a result. The full host, not the bare domain, since the bare domain may not serve one. */
export function iconHost(result: Pick<FusedResult, 'url' | 'host'>): string {
  if (result.host) return result.host;
  try {
    return new URL(result.url).hostname;
  } catch {
    return '';
  }
}

/** Google-style address line: `example.com › docs › page`. */
export function breadcrumb(result: Pick<FusedResult, 'url' | 'host'>): string {
  try {
    const url = new URL(result.url);
    const host = (result.host ?? url.hostname).replace(/^www\./, '');
    // Sogou's redirect links carry no path worth showing.
    if (/(^|\.)sogou\.com$/.test(url.hostname) && url.pathname === '/link') return host;
    const parts = decodeURI(url.pathname).split('/').filter(Boolean);
    const shown = parts.slice(0, 3).map((part) => (part.length > 28 ? `${part.slice(0, 27)}…` : part));
    return [host, ...shown, parts.length > 3 ? '…' : ''].filter(Boolean).join(' › ');
  } catch {
    return result.host ?? result.url;
  }
}

/** Proper spellings for sites whose names can't be recovered from the domain by capitalizing. */
const KNOWN_SITES: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  stackoverflow: 'Stack Overflow',
  stackexchange: 'Stack Exchange',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  twitter: 'X',
  x: 'X',
  mongodb: 'MongoDB',
  openai: 'OpenAI',
  arxiv: 'arXiv',
  npmjs: 'npm',
  pypi: 'PyPI',
  nvidia: 'NVIDIA',
  ieee: 'IEEE',
  acm: 'ACM',
  sciencedirect: 'ScienceDirect',
  csdn: 'CSDN',
};

/** Sites whose name is written in the interface language (the message is `site.<name>`). */
const LOCALIZED_SITES: Record<string, Extract<MessageKey, `site.${string}`>> = {
  taobao: 'site.taobao',
  tmall: 'site.tmall',
  jd: 'site.jd',
  zhihu: 'site.zhihu',
  bilibili: 'site.bilibili',
  douyin: 'site.douyin',
  juejin: 'site.juejin',
  cnblogs: 'site.cnblogs',
  jianshu: 'site.jianshu',
  douban: 'site.douban',
  baidu: 'site.baidu',
  weixin: 'site.weixin',
  sina: 'site.sina',
  sohu: 'site.sohu',
};

/** Short site label above the title: `docs.github.com` → `GitHub`. Falls back to the capitalized domain name. */
export function siteLabel(result: Pick<FusedResult, 'url' | 'host' | 'meta'>): string {
  if (result.meta.siteName) return result.meta.siteName;
  const host = (result.host ?? hostOf(result.url)).replace(/^www\./, '');
  const labels = host.split('.');
  if (labels.length < 2) return host;
  const compoundTld = /^(co|com|org|net|gov|edu|ac)$/.test(labels[labels.length - 2]) && labels[labels.length - 1].length === 2;
  const name = labels[labels.length - (compoundTld ? 3 : 2)] ?? labels[0];
  const localized = LOCALIZED_SITES[name.toLowerCase()];
  return (localized ? t(localized) : KNOWN_SITES[name.toLowerCase()]) ?? name.charAt(0).toUpperCase() + name.slice(1);
}

/** 1218 → 1.2K, 16661 → 16.7K, 5026349 → 5M: counts the way X prints them. */
export function compactCount(value: number): string {
  if (value < 1000) return String(value);
  const [divisor, unit] = value >= 999_500_000 ? [1e9, 'B'] : value >= 999_500 ? [1e6, 'M'] : [1e3, 'K'];
  const scaled = value / divisor;
  return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${unit}`;
}

export function formatDuration(ms: number): string {
  return t('newtab.duration.seconds', { seconds: ms < 1000 ? (ms / 1000).toFixed(2) : (ms / 1000).toFixed(1) });
}

/** "Since" years offered in academic mode, like Scholar: this year, last year, four years back. */
export function sinceYears(now = new Date()): number[] {
  const year = now.getFullYear();
  return [year, year - 1, year - 4];
}

/** The community platforms whose posts a general search can pull in (each also has a tab of its own). */
export type Platform = 'zhihu' | 'xiaohongshu' | 'wechat';

/** The platform's name in the interface language. */
export const platformName = (platform: Platform): string => t(`platform.${platform}`);

/** What core's engines write into `meta.siteName` for a Zhihu answer and a WeChat article: data to compare with, not interface text. */
export const ZHIHU_SITE_NAME = '知乎'; // i18n-ignore (data written by core's engines, not interface text)
export const WECHAT_SITE_NAME = '微信公众号'; // i18n-ignore (data written by core's engines, not interface text)

/** Which platform a result is a post from; null for an ordinary page. Mirrors how `Results.tsx` picks a card. */
export function platformOf(result: Pick<FusedResult, 'note' | 'meta'>): Platform | null {
  if (result.note) return 'xiaohongshu';
  if (result.meta.siteName === ZHIHU_SITE_NAME) return 'zhihu';
  if (result.meta.siteName === WECHAT_SITE_NAME) return 'wechat';
  return null;
}

/**
 * Pulls the community posts out of a general result list for the "各平台怎么说" block: at least `min` of them (a lone
 * post stays where it ranked), at most `max` and `perPlatform` from any one platform so one voice doesn't fill it.
 * What doesn't fit stays in the list, in its place.
 */
export function splitPlatforms(results: FusedResult[], { min = 2, max = 6, perPlatform = 3 } = {}): { platform: FusedResult[]; rest: FusedResult[] } {
  const taken = new Map<Platform, number>();
  const platform: FusedResult[] = [];
  for (const result of results) {
    const p = platformOf(result);
    if (!p || platform.length >= max || (taken.get(p) ?? 0) >= perPlatform) continue;
    taken.set(p, (taken.get(p) ?? 0) + 1);
    platform.push(result);
  }
  if (platform.length < min) return { platform: [], rest: results };
  return { platform, rest: results.filter((r) => !platform.includes(r)) };
}

/** Same whole-title key as core's `paperTitleKey` (this bundle doesn't import core's runtime). */
const titleKey = (title: string) => title.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');

/** The results that are the papers the model named and the index confirmed, in the order it named them (matched by DOI, else by whole title). */
export function pickLandmarks(results: FusedResult[], landmarks: VerifiedLandmark[]): FusedResult[] {
  const picked: FusedResult[] = [];
  for (const landmark of landmarks) {
    const key = titleKey(landmark.title);
    const found = results.find((r) => !picked.includes(r) && ((landmark.doi && r.meta.doi?.toLowerCase() === landmark.doi.toLowerCase()) || titleKey(r.title) === key));
    if (found) picked.push(found);
  }
  return picked;
}

/** Papers published in `since` or later; papers with an unknown year can't be placed, so they drop out. */
export function filterSince(results: FusedResult[], since?: number): FusedResult[] {
  if (since === undefined) return results;
  return results.filter((r) => (r.meta.year ?? (r.publishedAt ? Number(r.publishedAt.slice(0, 4)) : 0)) >= since);
}

export type PaperSort = 'relevance' | 'citations';

export function sortPapers(results: FusedResult[], by: PaperSort): FusedResult[] {
  if (by === 'relevance') return results;
  return [...results].sort((a, b) => (b.meta.citations ?? -1) - (a.meta.citations ?? -1));
}

/** Every mode, in tab order; typed over `SearchMode`, so a new mode can't be left out. */
const MODE_ORDER = { web: true, images: true, video: true, news: true, shopping: true, academic: true, zhihu: true, xiaohongshu: true, wechat: true, x: true } satisfies Record<SearchMode, true>;
export const MODES = Object.keys(MODE_ORDER) as SearchMode[];

/** The tab's name in the interface language. */
export const modeLabel = (mode: SearchMode): string => t(`mode.${mode}`);

/** The platform tabs, folded under one "社区" tab. */
export const COMMUNITY_MODES: SearchMode[] = ['zhihu', 'xiaohongshu', 'wechat', 'x'];
export const isCommunityMode = (mode: SearchMode): boolean => COMMUNITY_MODES.includes(mode);

/** Whether the AI overview and the hidden-results fold apply. Mirrors `modeHasText` in core, which this bundle avoids importing. */
export function modeHasOverview(mode: SearchMode): boolean {
  return mode === 'web' || mode === 'news' || mode === 'academic' || mode === 'zhihu' || mode === 'wechat';
}

/**
 * A service's error in words a person can act on. The raw text (a status line and a JSON body) stays available as a tooltip;
 * an error that isn't recognised is returned as it is.
 */
export function explainServiceError(message: string): string {
  if (/HTTP 451/.test(message)) return t('newtab.serviceError.region');
  if (/HTTP 40[13]/.test(message)) return t('newtab.serviceError.key', { status: /HTTP (40[13])/.exec(message)?.[1] ?? '401' });
  if (/HTTP 429/.test(message)) return t('newtab.serviceError.rateLimit');
  if (/Failed to fetch|NetworkError|network/i.test(message)) return t('newtab.serviceError.network');
  return message;
}

/**
 * What to tell the reader when the decision model could not be used for this search: one line saying what was skipped and why,
 * not one per feature when the reason is the same. Nothing when nothing went wrong.
 */
export function decisionModelNotes(s: { mode: SearchMode; judgeError?: string; intentError?: string }): { text: string; title: string }[] {
  const failed = [
    ...(s.mode === 'web' && s.intentError ? [{ what: 'intent' as const, raw: s.intentError }] : []),
    ...(s.judgeError ? [{ what: 'judge' as const, raw: s.judgeError }] : []),
  ].map((f) => ({ ...f, reason: explainServiceError(f.raw) }));
  if (!failed.length) return [];
  if (failed.every((f) => f.reason === failed[0].reason)) {
    const text = failed.length > 1 ? t('newtab.decisionNote.both', { reason: failed[0].reason }) : t(`newtab.decisionNote.${failed[0].what}`, { reason: failed[0].reason });
    return [{ text, title: failed.map((f) => f.raw).join('\n') }];
  }
  return failed.map((f) => ({ text: t(`newtab.decisionNote.${f.what}`, { reason: f.reason }), title: f.raw }));
}

/** First `max` characters on one line, with an ellipsis when cut. */
export function clip(text: string | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function parseMode(value: string | null): SearchMode {
  return MODES.find((mode) => mode === value) ?? 'web';
}

export function searchUrl(base: string, query: string, mode: SearchMode, news?: NewsOptions): string {
  const url = new URL(base);
  if (query) url.searchParams.set('q', query);
  else url.searchParams.delete('q');
  if (mode === 'web') url.searchParams.delete('m');
  else url.searchParams.set('m', mode);
  if (mode === 'news' && news?.range && news.range !== 'any') url.searchParams.set('range', news.range);
  else url.searchParams.delete('range');
  if (mode === 'news' && news?.sort === 'date') url.searchParams.set('sort', news.sort);
  else url.searchParams.delete('sort');
  return url.toString();
}
