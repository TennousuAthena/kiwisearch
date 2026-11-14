import { DEFAULT_CONFIG, activeSubscriptions, mergeConfig, migrateConfig, type BlocklistSource, type ParsedBlocklist } from '@kiwi-search/core';
import { getLocale, t } from '@kiwi-search/app/i18n';

/**
 * The pure part of keeping subscribed block lists: what is remembered about each, when one is due, how a download is read
 * and how the settings page words the result. `blocklistService.ts` does the storing and fetching.
 */

export interface BlocklistMeta {
  /** The address the kept rules came from. A changed address starts over. */
  url: string;
  /** When the kept rules were last replaced. Missing: nothing is kept yet. */
  fetchedAt?: number;
  /** The last attempt, successful or not. */
  attemptedAt?: number;
  etag?: string;
  /** Rules kept, and what was left out of the list (see `ParsedBlocklist.stats`). */
  rules?: number;
  cosmetic?: number;
  unsupported?: number;
  /** The last attempt failed with this; the rules kept from before stay in use. */
  error?: string;
  /** Set while a download is running. A worker that died mid-download leaves it behind, so it goes stale. */
  updatingSince?: number;
}

export type BlocklistMetaMap = Record<string, BlocklistMeta>;

export const MAX_LIST_BYTES = 12 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Lists change at most daily; asking again sooner only costs the host bandwidth. */
export const REFRESH_AFTER_MS = 24 * 3600_000;
/** After a failure, try again after this long (not on every wake of the worker). */
export const RETRY_AFTER_MS = 3600_000;
export const UPDATING_STALE_MS = 2 * 60_000;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type Download = { kind: 'not-modified' } | { kind: 'text'; text: string; etag?: string };

export const isUpdating = (meta: BlocklistMeta | undefined, now: number): boolean => !!meta?.updatingSince && now - meta.updatingSince < UPDATING_STALE_MS;

/** Whether this list should be fetched now. */
export function isDue(meta: BlocklistMeta | undefined, source: Pick<BlocklistSource, 'url'>, now: number): boolean {
  if (!meta || meta.url !== source.url) return true;
  if (isUpdating(meta, now)) return false;
  return now - (meta.attemptedAt ?? 0) >= (meta.error ? RETRY_AFTER_MS : REFRESH_AFTER_MS);
}

/**
 * Whether a change to the stored config calls for a pass over the lists: one switched on, added or given another address (something to
 * fetch), or one removed or switched off (something to forget). Editing the user's own rules does not.
 */
export function subscriptionsChanged(change: { oldValue?: unknown; newValue?: unknown } | undefined): boolean {
  if (!change) return false;
  const key = (stored: unknown) => {
    const lists = mergeConfig(DEFAULT_CONFIG, migrateConfig(stored)).judge.blocklists;
    return JSON.stringify([activeSubscriptions(lists), [...lists.recommended, ...lists.subscriptions.map((sub) => sub.id)].sort()]);
  };
  return key(change.oldValue) !== key(change.newValue);
}

/** The body as text, refusing to read more than `maxBytes` (a subscription address that points at something huge, or never ends). */
export async function readTextLimited(response: Response, maxBytes = MAX_LIST_BYTES): Promise<string> {
  const tooBig = () => new Error(t('options.blocklist.error.tooBig', { megabytes: Math.round(maxBytes / 1024 / 1024) }));
  if (Number(response.headers.get('content-length')) > maxBytes) throw tooBig();
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw tooBig();
    return text;
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function explain(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) return t('options.blocklist.error.timeout', { seconds: DOWNLOAD_TIMEOUT_MS / 1000 });
  if (error instanceof TypeError) return t('options.blocklist.error.unreachable');
  return error instanceof Error ? error.message : String(error);
}

/**
 * One request for a list. No cookies and no referrer go with it, so the host learns only that some browser asked for the file.
 * With the `etag` of what is kept the host may answer "not modified".
 */
export async function downloadList(fetchFn: FetchFn, url: string, etag?: string, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<Download> {
  try {
    const response = await fetchFn(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      headers: etag ? { 'If-None-Match': etag } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 304) return { kind: 'not-modified' };
    if (!response.ok) throw new Error(t('options.blocklist.error.http', { status: response.status }));
    return { kind: 'text', text: await readTextLimited(response), etag: response.headers.get('etag') ?? undefined };
  } catch (error) {
    throw new Error(explain(error));
  }
}

/** The meta after a successful download that replaced the kept rules. */
export function metaAfterDownload(url: string, parsed: ParsedBlocklist, etag: string | undefined, now: number): BlocklistMeta {
  return { url, fetchedAt: now, attemptedAt: now, etag, rules: parsed.stats.rules, cosmetic: parsed.stats.cosmetic, unsupported: parsed.stats.unsupported };
}

export function formatAgo(from: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - from) / 60_000));
  if (minutes < 1) return t('options.blocklist.ago.now');
  if (minutes < 60) return t('options.blocklist.ago.minutes', { minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('options.blocklist.ago.hours', { hours });
  return t('options.blocklist.ago.days', { days: Math.round(hours / 24) });
}

export interface BlocklistStatus {
  tone: 'ok' | 'bad' | 'neutral';
  text: string;
}

const count = (n: number) => n.toLocaleString(getLocale());

/** The line under a subscribed list on the settings page. */
export function blocklistStatus(meta: BlocklistMeta | undefined, now: number): BlocklistStatus {
  if (isUpdating(meta, now)) return { tone: 'neutral', text: t('options.blocklist.status.downloading') };
  const kept = meta?.fetchedAt ? { rules: count(meta.rules ?? 0), ago: formatAgo(meta.fetchedAt, now) } : undefined;
  if (meta?.error) return { tone: 'bad', text: kept ? t('options.blocklist.status.refreshFailed', { error: meta.error, ...kept }) : t('options.blocklist.status.failed', { error: meta.error }) };
  if (!kept) return { tone: 'neutral', text: t('options.blocklist.status.waiting') };
  return {
    tone: 'ok',
    text: meta?.unsupported ? t('options.blocklist.status.keptSkipped', { ...kept, skipped: count(meta.unsupported) }) : t('options.blocklist.status.kept', kept),
  };
}

/** What the user's own rules came to: how many were understood, and what was left out. */
export function describeCustomRules(stats: ParsedBlocklist['stats']): string {
  if (!stats.rules && !stats.unsupported && !stats.cosmetic) return '';
  const parts = [t('options.blocklist.custom.valid', { count: count(stats.rules) })];
  if (stats.unsupported) {
    const examples = stats.examples.map((line) => t('options.blocklist.custom.example', { line })).join(t('options.listSeparator'));
    parts.push(
      stats.examples.length
        ? t('options.blocklist.custom.unsupportedExamples', { count: count(stats.unsupported), examples })
        : t('options.blocklist.custom.unsupported', { count: count(stats.unsupported) }),
    );
  }
  if (stats.cosmetic) parts.push(t('options.blocklist.custom.cosmetic', { count: count(stats.cosmetic) }));
  return parts.join(t('options.clauseSeparator'));
}
