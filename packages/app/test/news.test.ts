import type { FusedResult } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import { formatNewsDate, newsTime, parseNewsOptions } from '../src/lib/news';
import { hiddenLabel, parseMode, searchUrl } from '../src/lib/results';

const base = 'chrome-extension://abc/newtab.html';
const news = (overrides: Partial<FusedResult['news']> = {}): NonNullable<FusedResult['news']> => ({
  timeKind: 'published', retrievedAt: '2026-11-13T09:00:00Z', ...overrides,
});

describe('news URL state', () => {
  it('restores a query and its conditions, including through a separately reopened URL', () => {
    const url = new URL(searchUrl(base, '中文 & updates?', 'news', { range: 'week', sort: 'date' }));
    expect(url.searchParams.get('q')).toBe('中文 & updates?');
    expect(parseMode(url.searchParams.get('m'))).toBe('news');
    expect(parseNewsOptions(new URL(url.href).searchParams)).toEqual({ range: 'week', sort: 'date' });
    const previous = new URL(searchUrl(base, 'earlier', 'news', { range: 'day', sort: 'relevance' }));
    expect(parseNewsOptions(previous.searchParams)).toEqual({ range: 'day', sort: 'relevance' });
  });

  it('keeps an empty news tab in the URL without inventing a search query', () => {
    const url = new URL(searchUrl(`${base}?q=old`, '', 'news', { range: 'month', sort: 'date' }));
    expect(url.searchParams.has('q')).toBe(false);
    expect(url.searchParams.get('m')).toBe('news');
    expect(parseNewsOptions(url.searchParams)).toEqual({ range: 'month', sort: 'date' });
  });

  it('removes stale news fields in other modes and leaves default news URLs short', () => {
    expect(searchUrl(`${base}?range=day&sort=date`, 'q', 'news', { range: 'any', sort: 'relevance' })).toBe(`${base}?q=q&m=news`);
    const switched = new URL(searchUrl(`${base}?m=news&range=day&sort=date`, 'q', 'academic'));
    expect(switched.searchParams.get('m')).toBe('academic');
    expect(switched.searchParams.has('range')).toBe(false);
    expect(switched.searchParams.has('sort')).toBe(false);
  });

  it('falls back safely for unrecognized or omitted conditions', () => {
    expect(parseNewsOptions(new URLSearchParams('range=year&sort=popular'))).toEqual({ range: 'any', sort: 'relevance' });
    expect(parseNewsOptions(new URLSearchParams())).toEqual({ range: 'any', sort: 'relevance' });
  });
});

describe('news publication evidence', () => {
  it('does not shift a date-only report or manufacture a midnight publication time', () => {
    const day = formatNewsDate('2026-11-13', 'day', 'America/Los_Angeles');
    expect(day).toBe(formatNewsDate('2026-11-13', 'day', 'Asia/Hong_Kong'));
    expect(day).toBe('2026/11/13');
    expect(formatNewsDate('2026-02-30', 'day')).toBeUndefined();
  });

  it('displays known time in the reader timezone without adding finer source precision', () => {
    expect(formatNewsDate('2026-11-13T02:15:00Z', 'minute', 'Asia/Hong_Kong')).toBe('2026/11/13 10:15');
    const hourly = formatNewsDate('2026-11-13T02:15:00Z', 'hour', 'Asia/Hong_Kong');
    expect(hourly).toContain('10');
    expect(hourly).not.toContain('15');
    expect(formatNewsDate('2026-11-13T02:15:00', 'minute')).toBeUndefined();
  });

  it('distinguishes updates from publication and retains unparsed source text', () => {
    const updated = newsTime({ publishedAt: '2026-11-11', news: news({ timeKind: 'updated', updatedAt: '2026-11-13T02:15:00Z', timeText: 'Updated 2 hours ago' }) }, 'Asia/Hong_Kong');
    expect(updated).toEqual({ label: '2026/11/13 10:15 更新', dateTime: '2026-11-13T02:15:00Z', title: 'Updated 2 hours ago' });
    expect(newsTime({ news: news({ timeKind: 'unknown', timeText: '昨日晚间' }) })).toEqual({ label: '昨日晚间' });
  });

  it('never displays crawl time as a publication date and explains time exclusions', () => {
    expect(newsTime({ news: news({ timeKind: 'unknown' }) }).label).toBe('发布时间未注明');
    expect(newsTime({ publishedAt: 'not a date', news: news({ timeText: '3 小时前' }) })).toEqual({ label: '3 小时前 发布' });
    expect(hiddenLabel({ reason: 'time', detail: 'outside' })).toBe('发布时间不在所选范围内');
    expect(hiddenLabel({ reason: 'time', detail: 'unknown' })).toContain('发布时间不明确');
  });
});
