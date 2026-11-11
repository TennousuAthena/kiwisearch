import type { FusedResult, SearchHit, SourceId } from './types';
import { isGoogleGotoUrl } from './engines/google';
import { normalizeUrl } from './url';

export const RRF_K = 60;

function normalizedHost(value: string): string {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizedTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+(?:-|\|)\s+[^-|]+$/u, '')
    .replace(/(?:\.{3}|…)+\s*$/u, '')
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

function titlesMatch(left: string, right: string): boolean {
  if (left === right) return true;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  return shorter.length >= 25 && longer.startsWith(shorter);
}

function matchesWrapperPair(left: FusedResult, right: FusedResult): boolean {
  const leftIsWrapper = isGoogleGotoUrl(left.url);
  const rightIsWrapper = isGoogleGotoUrl(right.url);
  if (leftIsWrapper === rightIsWrapper) return false;
  const wrapper = leftIsWrapper ? left : right;
  const page = leftIsWrapper ? right : left;
  const host = wrapper.host ? normalizedHost(wrapper.host) : '';
  const title = normalizedTitle(wrapper.title);
  return !!host && !!title && normalizedHost(page.url) === host && titlesMatch(title, normalizedTitle(page.title));
}

/**
 * Merge per-source ranked lists with Reciprocal Rank Fusion:
 * score(d) = sum_s w_s / (k + rank_s(d)).
 */
export function fuse(
  lists: SearchHit[][],
  weights: Partial<Record<SourceId, number>> = {},
  k = RRF_K,
): FusedResult[] {
  const byKey = new Map<string, FusedResult>();
  for (const list of lists) {
    for (const hit of list) {
      if (!hit.url || !/^https?:/i.test(hit.url)) continue;
      const key = normalizeUrl(hit.url);
      const w = weights[hit.source] ?? 1;
      const contribution = w / (k + hit.rank);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          key,
          url: hit.url,
          host: hit.host,
          title: hit.title,
          snippet: hit.snippet,
          sources: [{ source: hit.source, rank: hit.rank }],
          rrfScore: contribution,
          score: 0,
          content: hit.content,
          publishedAt: hit.publishedAt,
          meta: { ...hit.meta },
        });
        continue;
      }
      if (existing.sources.some((s) => s.source === hit.source)) continue;
      existing.sources.push({ source: hit.source, rank: hit.rank });
      existing.rrfScore += contribution;
      existing.host ??= hit.host;
      if (hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet;
      if (!existing.title && hit.title) existing.title = hit.title;
      if (hit.content && (!existing.content || hit.content.length > existing.content.length)) {
        existing.content = hit.content;
      }
      existing.publishedAt ??= hit.publishedAt;
      existing.meta = { ...hit.meta, ...existing.meta };
    }
  }
  const values = [...byKey.values()];
  const wrappers = values.filter((result) => isGoogleGotoUrl(result.url));
  const results = values.filter((result) => !isGoogleGotoUrl(result.url));
  for (const wrapper of wrappers) {
    const match = results.find((result) => matchesWrapperPair(wrapper, result));
    if (!match) {
      results.push(wrapper);
      continue;
    }
    for (const source of wrapper.sources) {
      if (match.sources.some((existing) => existing.source === source.source)) continue;
      match.sources.push(source);
      match.rrfScore += (weights[source.source] ?? 1) / (k + source.rank);
    }
    match.host ??= wrapper.host;
    if (wrapper.snippet.length > match.snippet.length) match.snippet = wrapper.snippet;
    if (wrapper.content && (!match.content || wrapper.content.length > match.content.length)) {
      match.content = wrapper.content;
    }
    match.publishedAt ??= wrapper.publishedAt;
    match.meta = { ...wrapper.meta, ...match.meta };
  }
  results.sort((a, b) => b.rrfScore - a.rrfScore);
  const max = results[0]?.rrfScore ?? 1;
  for (const r of results) r.score = r.rrfScore / max;
  return results;
}

export function mergeLateHits(
  results: FusedResult[],
  hits: SearchHit[],
  weights: Partial<Record<SourceId, number>> = {},
  k = RRF_K,
): FusedResult[] {
  const merged = results.map((result) => ({
    ...result,
    sources: result.sources.map((source) => ({ ...source })),
    meta: { ...result.meta },
  }));
  for (const late of fuse([hits], weights, k)) {
    const existing = merged.find(
      (result) => normalizeUrl(result.url) === late.key || matchesWrapperPair(result, late),
    );
    if (!existing) {
      merged.push({ ...late, late: true, score: 0 });
      continue;
    }
    for (const source of late.sources) {
      if (existing.sources.some((current) => current.source === source.source)) continue;
      existing.sources.push({ ...source });
      existing.rrfScore += (weights[source.source] ?? 1) / (k + source.rank);
    }
  }
  return merged;
}

/**
 * Blend reranker relevance (already normalized to [0,1]) with the RRF prior.
 * Candidates without a rerank score keep their RRF-based score scaled down so
 * they sort below reranked ones.
 */
export function applyRerank(
  results: FusedResult[],
  scores: Map<string, number>,
  alpha = 0.75,
): FusedResult[] {
  const maxRrf = Math.max(...results.map((r) => r.rrfScore), 1e-9);
  const out = results.map((r) => {
    const rr = scores.get(r.key);
    const prior = r.rrfScore / maxRrf;
    return rr === undefined
      ? { ...r, score: prior * (1 - alpha) }
      : { ...r, rerankScore: rr, score: alpha * rr + (1 - alpha) * prior };
  });
  return out.sort((a, b) => b.score - a.score);
}
