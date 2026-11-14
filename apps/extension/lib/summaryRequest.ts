import type { SummaryRequest } from '@kiwi-search/protocol';

const TEXT_MODES = new Set(['web', 'news', 'academic', 'zhihu', 'wechat']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;

export function isExtensionPageSender(sender: { id?: string; url?: string } | undefined, id: string, baseUrl: string): boolean {
  if (sender?.id !== id || !sender.url) return false;
  try {
    const url = new URL(sender.url); const base = new URL(baseUrl);
    return url.protocol === base.protocol && url.host === base.host && ['/newtab.html', '/options.html'].includes(url.pathname);
  } catch { return false; }
}

/** Bound payloads from an extension page; arbitrary content scripts cannot invoke model requests. */
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
