import type { PipelineEvent, SourceId } from '@kiwi-search/core';

/** What the last search that used a source found out about it. The settings page shows this next to the source. */
export type SourceHealth =
  | { state: 'ok'; at: number; count: number }
  /** Ran fine and found nothing, which for a narrow query is normal. */
  | { state: 'empty'; at: number }
  /** The browser isn't signed in to the site. */
  | { state: 'login'; at: number }
  | { state: 'captcha'; at: number }
  | { state: 'error'; at: number; message: string };

export type SourceHealthMap = Partial<Record<SourceId, SourceHealth>>;

/** What a pipeline event says about its source's health; null when it says nothing. */
export function healthFromEvent(event: PipelineEvent, now = Date.now()): { source: SourceId; health: SourceHealth } | null {
  switch (event.type) {
    case 'source_blocked':
      return { source: event.source, health: { state: event.reason === 'login' ? 'login' : 'captcha', at: now } };
    case 'source_done':
      return { source: event.source, health: event.count > 0 ? { state: 'ok', at: now, count: event.count } : { state: 'empty', at: now } };
    case 'late_results':
      return { source: event.source, health: { state: 'ok', at: now, count: event.results.length } };
    case 'source_error':
      return { source: event.source, health: { state: 'error', at: now, message: event.error.slice(0, 200) } };
    default:
      return null;
  }
}

/** "刚刚", "5 分钟前", "3 小时前", "2 天前". */
export function ageLabel(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return '刚刚';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}
