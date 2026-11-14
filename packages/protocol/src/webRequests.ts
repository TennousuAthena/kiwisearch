import type { SourceId } from '@kiwi-search/core';
import type { DomainPreferenceAction, DomainPreferenceUndo } from './settings';
import type { SearchRequest, SummaryRequest } from './messages';
import { normalizeDomain } from './domains';
import { parsePreferenceSave, type PreferenceValues } from './preferences';

/**
 * What the service worker accepts from a website, checked field by field. A request that does not match exactly is refused (null),
 * and what comes out is built from the checked fields, never the page's own object, so nothing the page adds travels further.
 * The limits follow `parseSummaryRequest`: a page is not trusted to keep a request small.
 */

// A copy of `SEARCH_MODES` in core, which the interface and this package do not import (it would pull the parsers into the page).
// `apps/extension/test/protocolMirror.test.ts` fails if the two lists differ.
export const SEARCH_MODES = ['web', 'images', 'video', 'news', 'shopping', 'academic', 'zhihu', 'xiaohongshu', 'wechat', 'x'] as const;
type Mode = (typeof SEARCH_MODES)[number];
const isMode = (value: unknown): value is Mode => typeof value === 'string' && (SEARCH_MODES as readonly string[]).includes(value);
const TEXT_MODES = new Set(['web', 'news', 'academic', 'zhihu', 'wechat']);

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const SOURCE_ID = /^[a-z0-9_-]{1,40}$/;

export function parseFaviconParams(params: unknown): { host: string } | null {
  return record(params) && text(params.host, 253) && /^[^\s/?#@]{1,253}$/.test(params.host) ? { host: params.host } : null;
}

export function parseFocusWorkerParams(params: unknown): { source: string } | null {
  return record(params) && typeof params.source === 'string' && SOURCE_ID.test(params.source) ? { source: params.source } : null;
}

export function parseDomainPreferenceParams(params: unknown): { action: DomainPreferenceAction; domain: string } | null {
  if (!record(params) || !text(params.domain, 253) || !['block', 'boost', 'clear'].includes(String(params.action))) return null;
  const domain = normalizeDomain(params.domain);
  return domain ? { action: params.action as DomainPreferenceAction, domain } : null;
}

const state = (value: unknown): value is { blocked: boolean; boosted: boolean } => record(value) && typeof value.blocked === 'boolean' && typeof value.boosted === 'boolean';

export function parseUndoParams(params: unknown): { undo: DomainPreferenceUndo } | null {
  if (!record(params) || !record(params.undo)) return null;
  const { domain, before, after, revision } = params.undo;
  if (!text(domain, 253) || !text(revision, 64) || !revision || !state(before) || !state(after)) return null;
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;
  return { undo: { domain: normalized, before: { blocked: before.blocked, boosted: before.boosted }, after: { blocked: after.blocked, boosted: after.boosted }, revision } };
}

export function parsePrefsSaveParams(params: unknown): { values: PreferenceValues } | null {
  if (!record(params)) return null;
  const values = parsePreferenceSave(params.values);
  return values ? { values } : null;
}

export function parseAcademicLanguageSaveParams(params: unknown): { language: 'any' | 'en' } | null {
  return record(params) && (params.language === 'any' || params.language === 'en') ? { language: params.language } : null;
}

export function parseOpenLocalParams(params: unknown): { query: string; mode: Mode } | null {
  if (!record(params) || !text(params.query, 4096)) return null;
  const mode = params.mode === undefined ? 'web' : params.mode;
  return isMode(mode) ? { query: params.query, mode } : null;
}

export function parseOpenOptionsParams(params: unknown): { section?: string } | null {
  if (params === undefined || params === null) return {};
  if (!record(params)) return null;
  if (params.section === undefined) return {};
  return typeof params.section === 'string' && /^[a-z-]{1,24}$/.test(params.section) ? { section: params.section } : null;
}

/** A request on the `search` stream. Only the three shapes the interface sends; the optional fields are copied one by one. */
export function parseSearchStreamMessage(raw: unknown): SearchRequest | null {
  if (!record(raw)) return null;
  if (raw.type === 'keepalive') return { type: 'keepalive' };
  if (raw.type === 'stop-summary') return { type: 'stop-summary' };
  if (raw.type !== 'search' || !text(raw.query, 4096) || !raw.query.trim()) return null;
  const request: Extract<SearchRequest, { type: 'search' }> = { type: 'search', query: raw.query };
  if (raw.mode !== undefined) { if (!isMode(raw.mode)) return null; request.mode = raw.mode; }
  if (raw.language !== undefined) { if (raw.language !== 'any' && raw.language !== 'en') return null; request.language = raw.language; }
  if (raw.refresh !== undefined) { if (typeof raw.refresh !== 'boolean') return null; request.refresh = raw.refresh; }
  if (raw.summarize !== undefined) { if (typeof raw.summarize !== 'boolean') return null; request.summarize = raw.summarize; }
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources) || raw.sources.length > 60 || !raw.sources.every((id) => typeof id === 'string' && SOURCE_ID.test(id))) return null;
    request.sources = raw.sources as SourceId[];
  }
  if (raw.news !== undefined) {
    // Core clamps the values itself; here only their kind and size are checked.
    if (!record(raw.news) || Object.keys(raw.news).some((key) => key !== 'range' && key !== 'sort') || !Object.values(raw.news).every((value) => text(value, 24))) return null;
    request.news = { ...raw.news } as NonNullable<typeof request.news>;
  }
  return request;
}

/** A request on the `summary` stream: a summarize request, or the stop and keepalive messages. */
export function parseSummaryStreamMessage(raw: unknown): SummaryRequest | { type: 'stop-summary' } | { type: 'keepalive' } | null {
  if (record(raw) && (raw.type === 'keepalive' || raw.type === 'stop-summary')) return { type: raw.type };
  return parseSummaryRequest(raw);
}

/** Bound payloads from a page: arbitrary scripts cannot start model requests, and what a page may send is capped. */
export function parseSummaryRequest(raw: unknown): SummaryRequest | null {
  if (!record(raw) || raw.type !== 'summarize' || !text(raw.query, 4096) || !raw.query.trim() || !TEXT_MODES.has(String(raw.mode))) return null;
  if (!Array.isArray(raw.results) || !raw.results.length || raw.results.length > 100) return null;
  try { if (JSON.stringify(raw).length > 1_000_000) return null; } catch { return null; }
  if (raw.reuse !== undefined && typeof raw.reuse !== 'boolean') return null;
  if (raw.summaryAt !== undefined && (!text(raw.summaryAt, 40) || !Number.isFinite(Date.parse(raw.summaryAt as string)))) return null;
  for (const r of raw.results) {
    if (!record(r) || !text(r.key, 8192) || !text(r.url, 8192) || !text(r.title, 4096) || !text(r.snippet, 30000) || !record(r.meta) || !Array.isArray(r.sources)) return null;
    if (r.content !== undefined && !text(r.content, 100000)) return null;
    if (r.publishedAt !== undefined && !text(r.publishedAt, 80)) return null;
    try { const url = new URL(r.url as string); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null; } catch { return null; }
    if (r.meta.authors !== undefined && (!Array.isArray(r.meta.authors) || !r.meta.authors.every((a) => text(a, 1024)))) return null;
    if (r.news !== undefined && !record(r.news)) return null;
  }
  if (raw.news !== undefined && (!record(raw.news) || !text(raw.news.requestedAt, 40))) return null;
  return structuredClone(raw) as unknown as SummaryRequest;
}
