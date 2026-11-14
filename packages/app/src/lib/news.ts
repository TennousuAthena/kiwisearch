import type { FusedResult, NewsOptions, NewsRange, NewsSort } from '@kiwi-search/core';
import { getLocale, t } from '../i18n';

// Kept here rather than importing core's runtime into the new-tab bundle.
export const NEWS_RANGES = ['any', 'day', 'week', 'month'] as const satisfies readonly NewsRange[];
export const NEWS_SORTS = ['relevance', 'date'] as const satisfies readonly NewsSort[];

export function parseNewsOptions(params: URLSearchParams): NewsOptions {
  return {
    range: NEWS_RANGES.find((value) => value === params.get('range')) ?? 'any',
    sort: NEWS_SORTS.find((value) => value === params.get('sort')) ?? 'relevance',
  };
}

/** Date-only evidence must never acquire a clock time or shift to a different local day. */
export function formatNewsDate(value: string, precision: 'minute' | 'hour' | 'day' = 'minute', timeZone?: string): string | undefined {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) || precision === 'day';
  if (!day && !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const timestamp = day ? `${value.slice(0, 10)}T12:00:00Z` : value;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  if (day && date.toISOString().slice(0, 10) !== value.slice(0, 10)) return undefined;
  return new Intl.DateTimeFormat(getLocale(), {
    year: 'numeric', month: '2-digit', day: '2-digit',
    ...(day ? { timeZone: 'UTC' } : { timeZone, hour: '2-digit', ...(precision === 'minute' ? { minute: '2-digit' } : {}), hourCycle: 'h23' }),
  }).format(date);
}

/** Prefer known publication/update evidence, then the source's raw text; retrieval time is never publication time. */
export function newsTime(result: Pick<FusedResult, 'publishedAt' | 'news'>, timeZone?: string): { label: string; dateTime?: string; title?: string } {
  const info = result.news;
  const value = info?.timeKind === 'updated' ? info.updatedAt : info?.timeKind === 'published' ? result.publishedAt : undefined;
  const formatted = value ? formatNewsDate(value, info?.timePrecision, timeZone) : undefined;
  const text = formatted ?? info?.timeText?.trim();
  if (!text) return { label: t('newtab.news.time.unknown') };
  const label = info?.timeKind === 'published' || info?.timeKind === 'updated' ? t(`newtab.news.time.${info.timeKind}`, { time: text }) : text;
  return { label, ...(formatted ? { dateTime: value } : {}), ...(formatted && info?.timeText ? { title: info.timeText } : {}) };
}

/** Ignore arrival order and engine agreement; only changed visible article evidence makes an overview stale. */
export function newsEvidence(results: FusedResult[]): string {
  return JSON.stringify(results.filter((result) => !result.hidden).map((result) => [
    result.key, result.url, result.title, result.snippet, result.content ?? '', result.publishedAt ?? '',
    result.news?.updatedAt ?? '', result.news?.publisher ?? '', result.news?.byline ?? '',
  ]).sort((left, right) => left[0].localeCompare(right[0])));
}
