import type { FusedResult, NewsInfo, NewsOptions, NewsRange } from './types';

const DAY = 86_400_000;

export function normalizeNewsOptions(options?: Partial<NewsOptions>): NewsOptions {
  return {
    range: options?.range === 'day' || options?.range === 'week' || options?.range === 'month' ? options.range : 'any',
    sort: options?.sort === 'date' ? 'date' : 'relevance',
  };
}

/** Rolling windows, anchored once when the search begins; a month is 30 days. */
export function newsCutoff(range: NewsRange, now: Date | number): number | undefined {
  const days = range === 'day' ? 1 : range === 'week' ? 7 : range === 'month' ? 30 : undefined;
  return days === undefined ? undefined : Number(now) - days * DAY;
}

function validCalendarDate(value: string): boolean {
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value;
}

/** Parse only explicit-zone timestamps, calendar dates, and bounded relative ages.
 * Local clock labels ("today 10:00", zone-free timestamps) stay text: the source's
 * timezone is not necessarily the browser's timezone. Dates never gain a fake time.
 */
export function parseNewsTime(raw: string | undefined, now = new Date(), kind: NewsInfo['timeKind'] = 'published'): { publishedAt?: string; news: NewsInfo } {
  const text = raw?.replace(/\s+/g, ' ').trim();
  const updated = /^(?:last\s+updated|updated|更新(?:于|於|时间|時間)?)[\s:：]*/i;
  const timeKind = kind === 'published' && text && updated.test(text) ? 'updated' : kind;
  const news: NewsInfo = { retrievedAt: now.toISOString(), timeKind, ...(text ? { timeText: text } : {}) };
  if (!text || timeKind === 'unknown') return { news };
  const value = text.replace(updated, '').replace(/^(?:published|发布于|發佈於|发布时间|發佈時間)[\s:：]*/i, '');
  let parsed: string | undefined;
  const relative = value.match(/^(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|[smhdw]|秒钟?|分鐘|分钟|小時|小时|天|日|周|週|个月|個月)\s*(?:ago|前)$/i);
  if (/^(?:just now|刚刚|剛剛)$/i.test(value)) {
    parsed = now.toISOString();
    news.timePrecision = 'minute';
  } else if (relative) {
    const unit = relative[2].toLowerCase();
    const factor = /^(?:seconds?|secs?|s|秒钟?)$/.test(unit) ? 1000
      : /^(?:minutes?|mins?|m|分鐘|分钟)$/.test(unit) ? 60_000
        : /^(?:hours?|hrs?|h|小時|小时)$/.test(unit) ? 3_600_000
          : /^(?:weeks?|w|周|週)$/.test(unit) ? 7 * DAY
            : /^(?:months?|个月|個月)$/.test(unit) ? 30 * DAY : DAY;
    const age = Number(relative[1]) * factor;
    if (Number.isFinite(age) && age >= 0 && age <= 3660 * DAY) {
      parsed = new Date(now.getTime() - age).toISOString();
      news.timePrecision = factor >= DAY ? 'day' : factor >= 3_600_000 ? 'hour' : 'minute';
    }
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(value) && validCalendarDate(value)) {
    if (value <= now.toISOString().slice(0, 10)) {
      parsed = value;
      news.timePrecision = 'day';
    }
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) && validCalendarDate(value.slice(0, 10))) {
    const stamp = Date.parse(value);
    if (Number.isFinite(stamp) && stamp <= now.getTime()) {
      parsed = new Date(stamp).toISOString();
      news.timePrecision = 'minute';
    }
  } else if (/\b(?:GMT|UTC|[+-]\d{4})$/.test(value)) {
    // HTTP/RFC dates used by some API sources carry an explicit timezone too.
    const stamp = Date.parse(value);
    if (Number.isFinite(stamp) && stamp <= now.getTime()) {
      parsed = new Date(stamp).toISOString();
      news.timePrecision = 'minute';
    }
  }
  if (!parsed) return { news };
  return timeKind === 'updated' ? { news: { ...news, updatedAt: parsed } } : { publishedAt: parsed, news };
}

function publication(result: FusedResult, now: number): { stamp: number; end: number } | undefined {
  if (result.news && result.news.timeKind !== 'published') return undefined;
  const value = result.publishedAt;
  if (!value) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!validCalendarDate(value.slice(0, 10))) return undefined;
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return undefined;
  const stamp = Date.parse(value);
  const retrievedAt = Date.parse(result.news?.retrievedAt ?? '');
  // A source arriving late can contain reporting published after this search
  // began. Its capture time bounds that evidence; the lower range bound stays fixed.
  const observedAt = Number.isFinite(retrievedAt) ? Math.max(now, retrievedAt) : now;
  if (!Number.isFinite(stamp) || stamp > observedAt) return undefined;
  // Day-only publication dates have no known clock time. A range crossing this
  // day cannot establish whether the article is inside it.
  if (dateOnly) return { stamp, end: stamp + DAY - 1 };
  // "1 day ago" is a rounded age, not evidence of an exact 24-hour timestamp.
  const uncertainty = result.news?.timePrecision === 'day' ? DAY : result.news?.timePrecision === 'hour' ? 3_600_000 : 0;
  return { stamp: stamp - Math.max(0, uncertainty - 1), end: stamp };
}

/** Deterministic time filtering and ordering, also used after judging and late merges. */
export function applyNewsOptions(results: FusedResult[], options: NewsOptions, now: Date | number): FusedResult[] {
  const cutoff = newsCutoff(options.range, now);
  const clock = Number(now);
  const times = new Map(results.map((r) => [r.key, publication(r, clock)]));
  const filtered = results.map((result): FusedResult => {
    const { hidden, ...rest } = result;
    const next: FusedResult = hidden?.reason === 'time' ? rest : result;
    if (cutoff === undefined || (next.hidden && (next.hidden.reason === 'blocked' || next.hidden.reason === 'rule'))) return next;
    const time = times.get(result.key);
    if (!time || (time.stamp < cutoff && time.end >= cutoff)) return { ...next, hidden: { reason: 'time', detail: 'unknown' } };
    if (time.end < cutoff) return { ...next, hidden: { reason: 'time', detail: 'outside' } };
    return next;
  });
  return filtered.sort((a, b) => {
    const visibility = Number(!!a.hidden) - Number(!!b.hidden);
    if (visibility) return visibility;
    if (options.sort === 'date') {
      const at = times.get(a.key)?.stamp;
      const bt = times.get(b.key)?.stamp;
      if (at !== undefined || bt !== undefined) {
        if (at === undefined) return 1;
        if (bt === undefined) return -1;
        if (at !== bt) return bt - at;
      }
    }
    return b.score - a.score || b.rrfScore - a.rrfScore || a.key.localeCompare(b.key);
  });
}
