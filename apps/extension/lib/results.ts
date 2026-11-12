import type { FusedResult, HiddenReason, SearchMode, VerifiedLandmark } from '@kiwi-search/core';

export function splitResults(results: FusedResult[]): { visible: FusedResult[]; hidden: FusedResult[] } {
  return { visible: results.filter((r) => !r.hidden), hidden: results.filter((r) => r.hidden) };
}

export function hiddenLabel(hidden: HiddenReason): string {
  switch (hidden.reason) {
    case 'junk':
      return '疑似内容农场或搬运内容';
    case 'irrelevant':
      return '与搜索内容关系不大';
    case 'rule':
      return `符合你的过滤规则：${hidden.rule}`;
    case 'blocked':
      return hidden.list ? `命中屏蔽列表「${hidden.list}」` : '来自你屏蔽的网站';
  }
}

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
  zhihu: '知乎',
  bilibili: '哔哩哔哩',
  juejin: '掘金',
  cnblogs: '博客园',
  jianshu: '简书',
  douban: '豆瓣',
  baidu: '百度',
  weixin: '微信',
  sina: '新浪',
  sohu: '搜狐',
};

/** Short site label above the title: `docs.github.com` → `GitHub`. Falls back to the capitalized domain name. */
export function siteLabel(result: Pick<FusedResult, 'url' | 'host' | 'meta'>): string {
  if (result.meta.siteName) return result.meta.siteName;
  const host = (result.host ?? hostOf(result.url)).replace(/^www\./, '');
  const labels = host.split('.');
  if (labels.length < 2) return host;
  const compoundTld = /^(co|com|org|net|gov|edu|ac)$/.test(labels[labels.length - 2]) && labels[labels.length - 1].length === 2;
  const name = labels[labels.length - (compoundTld ? 3 : 2)] ?? labels[0];
  return KNOWN_SITES[name.toLowerCase()] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

/** 1218 → 1.2K, 16661 → 16.7K, 5026349 → 5M: counts the way X prints them. */
export function compactCount(value: number): string {
  if (value < 1000) return String(value);
  const [divisor, unit] = value >= 999_500_000 ? [1e9, 'B'] : value >= 999_500 ? [1e6, 'M'] : [1e3, 'K'];
  const scaled = value / divisor;
  return `${scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10}${unit}`;
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${(ms / 1000).toFixed(2)} 秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

/** "Since" years offered in academic mode, like Scholar: this year, last year, four years back. */
export function sinceYears(now = new Date()): number[] {
  const year = now.getFullYear();
  return [year, year - 1, year - 4];
}

/** The community platforms whose posts a general search can pull in (each also has a tab of its own). */
export type Platform = 'zhihu' | 'xiaohongshu' | 'wechat';

export const PLATFORM_NAMES: Record<Platform, string> = { zhihu: '知乎', xiaohongshu: '小红书', wechat: '公众号' };

/** Which platform a result is a post from; null for an ordinary page. Mirrors how `Results.tsx` picks a card. */
export function platformOf(result: Pick<FusedResult, 'note' | 'meta'>): Platform | null {
  if (result.note) return 'xiaohongshu';
  if (result.meta.siteName === '知乎') return 'zhihu';
  if (result.meta.siteName === '微信公众号') return 'wechat';
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

export const MODE_LABELS: Record<SearchMode, string> = { web: '全部', images: '图片', video: '视频', academic: '学术', zhihu: '知乎', xiaohongshu: '小红书', wechat: '公众号', x: 'X' };
/** Tab order; derived from the label table so a new mode can't be left out. */
export const MODES = Object.keys(MODE_LABELS) as SearchMode[];

/** The platform tabs, folded under one "社区" tab. */
export const COMMUNITY_MODES: SearchMode[] = ['zhihu', 'xiaohongshu', 'wechat', 'x'];
export const isCommunityMode = (mode: SearchMode): boolean => COMMUNITY_MODES.includes(mode);

/** Whether the AI overview and the hidden-results fold apply. Mirrors `modeHasText` in core, which this bundle avoids importing. */
export function modeHasOverview(mode: SearchMode): boolean {
  return mode === 'web' || mode === 'academic' || mode === 'zhihu' || mode === 'wechat';
}

/**
 * A service's error in words a person can act on. The raw text (a status line and a JSON body) stays available as a tooltip;
 * an error that isn't recognised is returned as it is.
 */
export function explainServiceError(message: string): string {
  if (/HTTP 451/.test(message)) return '该服务在你当前的网络出口所在地区不可用（HTTP 451），请检查代理分流';
  if (/HTTP 40[13]/.test(message)) return 'Key 无效，或没有权限（HTTP ' + (/HTTP (40[13])/.exec(message)?.[1] ?? '401') + '）';
  if (/HTTP 429/.test(message)) return '请求太频繁，被服务限流了（HTTP 429）';
  if (/Failed to fetch|NetworkError|network/i.test(message)) return '网络连不上这个服务';
  return message;
}

/**
 * What to tell the reader when the decision model could not be used for this search: one line saying what was skipped and why,
 * not one per feature when the reason is the same. Nothing when nothing went wrong.
 */
export function decisionModelNotes(s: { mode: SearchMode; judgeError?: string; intentError?: string }): { text: string; title: string }[] {
  const failed = [
    ...(s.mode === 'web' && s.intentError ? [{ what: '自动补搜知乎等平台', raw: s.intentError }] : []),
    ...(s.judgeError ? [{ what: '智能过滤', raw: s.judgeError }] : []),
  ].map((f) => ({ ...f, reason: explainServiceError(f.raw) }));
  if (!failed.length) return [];
  if (failed.every((f) => f.reason === failed[0].reason)) {
    return [{ text: `${failed.map((f) => f.what).join('、')}没能用上：${failed[0].reason}`, title: failed.map((f) => f.raw).join('\n') }];
  }
  return failed.map((f) => ({ text: `${f.what}没能用上：${f.reason}`, title: f.raw }));
}

/** First `max` characters on one line, with an ellipsis when cut. */
export function clip(text: string | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function parseMode(value: string | null): SearchMode {
  return MODES.find((mode) => mode === value) ?? 'web';
}

export function searchUrl(base: string, query: string, mode: SearchMode): string {
  const url = new URL(base);
  url.searchParams.set('q', query);
  if (mode === 'web') url.searchParams.delete('m');
  else url.searchParams.set('m', mode);
  return url.toString();
}
