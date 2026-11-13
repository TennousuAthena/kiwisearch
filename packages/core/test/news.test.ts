import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { createSourceCache } from '../src/cache';
import { fuse, mergeLateHits } from '../src/fusion';
import { applyJudgments } from '../src/judge';
import { applyNewsOptions, newsCutoff, normalizeNewsOptions, parseNewsTime } from '../src/news';
import { buildSummaryMessages } from '../src/summarize';
import type { FusedResult, SearchHit } from '../src/types';

const now = new Date('2026-11-13T12:00:00Z');
const article = (id: string, time?: string, extra: Partial<SearchHit> = {}): SearchHit => ({
  source: 'google', url: `https://example.com/${id}`, title: 'Government publishes the new transport policy',
  snippet: 'The government published its new transport policy this morning, following a briefing for journalists about the upcoming changes.',
  rank: 1, ...parseNewsTime(time, now), ...extra,
});
const fused = (...hits: SearchHit[]) => fuse([hits], {}, undefined, { urlOnly: true });

describe('news time semantics', () => {
  it('normalizes options and anchors rolling day/week/30-day month ranges', () => {
    expect(normalizeNewsOptions()).toEqual({ range: 'any', sort: 'relevance' });
    expect(normalizeNewsOptions({ range: 'invalid', sort: 'invalid' } as never)).toEqual({ range: 'any', sort: 'relevance' });
    expect(newsCutoff('any', now)).toBeUndefined();
    expect(newsCutoff('day', now)).toBe(now.getTime() - 86_400_000);
    expect(newsCutoff('week', now)).toBe(now.getTime() - 7 * 86_400_000);
    expect(newsCutoff('month', now)).toBe(now.getTime() - 30 * 86_400_000);
  });

  it('preserves precision and timezone for explicit timestamps and relative ages', () => {
    expect(parseNewsTime('2026-11-13T18:30:00+08:00', now)).toMatchObject({ publishedAt: '2026-11-13T10:30:00.000Z', news: { timePrecision: 'minute', retrievedAt: now.toISOString() } });
    expect(parseNewsTime('2 hours ago', now)).toMatchObject({ publishedAt: '2026-11-13T10:00:00.000Z', news: { timeText: '2 hours ago', timePrecision: 'hour' } });
    expect(parseNewsTime('30 分钟前', now).publishedAt).toBe('2026-11-13T11:30:00.000Z');
    expect(parseNewsTime('2026-11-12', now)).toMatchObject({ publishedAt: '2026-11-12', news: { timePrecision: 'day' } });
    expect(parseNewsTime('Fri, 13 Nov 2026 10:00:00 GMT', now).publishedAt).toBe('2026-11-13T10:00:00.000Z');
  });

  it('does not invent a timezone, a valid calendar day or a publication date from update labels', () => {
    for (const label of ['今天 10:00', '2026-11-13T10:00:00', '2026-02-30', '2026-02-30T10:00:00Z', '2026-11-14T10:00:00Z', 'not a date']) {
      expect(parseNewsTime(label, now).publishedAt, label).toBeUndefined();
      expect(parseNewsTime(label, now).news.timeText).toBe(label);
    }
    expect(parseNewsTime('Updated 2 hours ago', now)).toMatchObject({ news: { timeKind: 'updated', updatedAt: '2026-11-13T10:00:00.000Z' } });
    expect(parseNewsTime('Updated 2 hours ago', now).publishedAt).toBeUndefined();
    expect(parseNewsTime('2 hours ago', now, 'unknown').publishedAt).toBeUndefined();
  });

  it('strict ranges hide unknown and boundary-day dates, keeping the reason after judging', () => {
    const list = fused(
      article('recent', '2026-11-13T10:00:00Z'), article('old', '2026-11-10T10:00:00Z'),
      article('unknown'), article('boundary', '2026-11-12'), article('rounded-age', '1 day ago'),
      article('updated', undefined, { publishedAt: '2026-11-13T11:00:00Z', news: { retrievedAt: now.toISOString(), timeKind: 'updated' } }),
    );
    const filtered = applyNewsOptions(list, { range: 'day', sort: 'date' }, now);
    expect(filtered.filter((r) => !r.hidden).map((r) => r.url)).toEqual(['https://example.com/recent']);
    expect(filtered.find((r) => r.url.endsWith('/old'))?.hidden).toEqual({ reason: 'time', detail: 'outside' });
    expect(filtered.filter((r) => r.hidden?.reason === 'time' && r.hidden.detail === 'unknown')).toHaveLength(4);
    const judgments = new Map(filtered.map((r) => [r.key, { relevance: 3, junk: 0, rules: [] }]));
    expect(applyJudgments(filtered, judgments, DEFAULT_CONFIG.judge).filter((r) => !r.hidden)).toHaveLength(1);
    expect(applyNewsOptions(filtered, { range: 'any', sort: 'date' }, now).filter((r) => !r.hidden)).toHaveLength(6);
  });

  it('keeps blocked sites hidden, sorts recent known dates first and breaks ties deterministically', () => {
    const list = fused(article('z', '2026-11-13T10:00:00Z'), article('a', '2026-11-13T10:00:00Z'), article('unknown'), article('blocked', '2026-11-13T11:00:00Z'));
    list.find((r) => r.url.endsWith('/blocked'))!.hidden = { reason: 'blocked' };
    const sorted = applyNewsOptions(list, { range: 'any', sort: 'date' }, now);
    expect(sorted.map((r) => r.url.split('/').at(-1))).toEqual(['a', 'z', 'unknown', 'blocked']);
  });

  it('accepts a late source publication after search start but never after its capture time', () => {
    const captured = new Date(now.getTime() + 10_000);
    const late = article('late', undefined, { ...parseNewsTime('2026-11-13T12:00:05Z', captured) });
    const future = article('future', undefined, { publishedAt: '2026-11-13T12:00:20Z', news: { timeKind: 'published', retrievedAt: captured.toISOString() } });
    const sorted = applyNewsOptions(fused(late, future), { range: 'day', sort: 'date' }, now);
    expect(sorted[0].title).toBe(late.title);
    expect(sorted[0].hidden).toBeUndefined();
    expect(sorted[1].hidden).toEqual({ reason: 'time', detail: 'unknown' });
  });
});

describe('news fusion and evidence snapshots', () => {
  it('keeps independent outlets with the same headline and excerpt, and DOI-related URLs, separate', () => {
    const hits = [article('one'), article('two', undefined, { url: 'https://www.sina.com.cn/two' })];
    expect(fuse([hits])).toHaveLength(1); // The ordinary web reprint heuristic still works.
    expect(fused(...hits)).toHaveLength(2);
    expect(fused(article('doi', undefined, { url: 'https://doi.org/10.1234/example' }), article('paper', undefined, { url: 'https://publisher.example/10.1234/example', meta: { doi: '10.1234/example', authors: ['A'] } }))).toHaveLength(2);
  });

  it('merges matching URLs but keeps the primary title, text, publisher and time together', () => {
    const primary = article('one', '2026-11-13T10:00:00Z');
    primary.news!.publisher = 'Original outlet';
    const duplicate = article('other', '2026-11-12T10:00:00Z', { source: 'bravesearch', url: primary.url + '?utm_source=search', title: 'Older title', snippet: primary.snippet.repeat(3) });
    duplicate.news!.publisher = 'Different index attribution';
    const [result] = fuse([[primary], [duplicate]], {}, undefined, { urlOnly: true });
    expect(result.sources).toHaveLength(2);
    expect(result).toMatchObject({ title: primary.title, snippet: primary.snippet, publishedAt: primary.publishedAt, news: primary.news });
    const late = mergeLateHits([result], [duplicate, article('fresh', '2026-11-13T11:00:00Z', { source: 'bravesearch' })], {}, undefined, { urlOnly: true });
    expect(late).toHaveLength(2);
    expect(applyNewsOptions(late, { range: 'any', sort: 'date' }, now)[0].url).toBe('https://example.com/fresh');
    expect(late[0].snippet).toBe(primary.snippet);
  });

  it('uses per-entry news cache TTL without moving a relative publication time', () => {
    let clock = now.getTime();
    const cache = createSourceCache(300_000, 20, () => clock);
    const hit = article('one', '2 hours ago');
    cache.set('news', [hit], 60_000);
    cache.set('web', [hit]);
    clock += 59_999;
    expect(cache.get('news')![0].publishedAt).toBe(hit.publishedAt);
    expect(cache.get('news')![0].news?.retrievedAt).toBe(now.toISOString());
    clock += 1;
    expect(cache.get('news')).toBeUndefined();
    expect(cache.get('web')).toBeDefined();
  });

  it('gives the summary exact available times, publisher, conflicting-report rules and evidence scope', () => {
    const [result] = fused(article('one', '2026-11-13T10:30:00Z'));
    result.news!.publisher = 'Example News';
    result.news!.updatedAt = '2026-11-13T11:00:00Z';
    const [system, user] = buildSummaryMessages('transport policy', [result], new Map(), undefined, now, 'news', 'English', { range: 'day', sort: 'date', requestedAt: now.toISOString() });
    expect(system.content).toContain('reports conflict');
    expect(system.content).toContain('2026-11-13T12:00:00.000Z');
    expect(system.content).toContain('not a claim of complete coverage');
    expect(user.content).toContain('Publisher: Example News');
    expect(user.content).toContain('Published: 2026-11-13T10:30:00.000Z');
    expect(user.content).toContain('Updated: 2026-11-13T11:00:00Z');
    expect(user.content).toContain('search excerpt only');
    expect(user.content).toContain('Time range: day; order: date');
  });
});
