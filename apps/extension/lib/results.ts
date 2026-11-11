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
      return '来自你屏蔽的网站';
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

/** Whether the AI overview and the hidden-results fold apply. Mirrors `modeHasText` in core, which this bundle avoids importing. */
export function modeHasOverview(mode: SearchMode): boolean {
  return mode === 'web' || mode === 'academic' || mode === 'zhihu' || mode === 'wechat';
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
