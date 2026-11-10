import type { FusedResult, SearchHit, SourceId } from './types';
import { normalizeUrl } from './url';

export const RRF_K = 60;

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
      if (hit.snippet.length > existing.snippet.length) existing.snippet = hit.snippet;
      if (!existing.title && hit.title) existing.title = hit.title;
      if (hit.content && (!existing.content || hit.content.length > existing.content.length)) {
        existing.content = hit.content;
      }
      existing.publishedAt ??= hit.publishedAt;
      existing.meta = { ...hit.meta, ...existing.meta };
    }
  }
  const results = [...byKey.values()].sort((a, b) => b.rrfScore - a.rrfScore);
  const max = results[0]?.rrfScore ?? 1;
  for (const r of results) r.score = r.rrfScore / max;
  return results;
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
