import type { FusedResult, HitMeta, SearchHit, SourceId } from './types';
import { isGoogleGotoUrl } from './engines/google';
import { normalizeUrl } from './url';

export const RRF_K = 60;

type Weights = Partial<Record<SourceId, number>>;

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

/** Merge metadata with `primary` winning, ignoring keys that are explicitly undefined on either side. */
function mergeMeta(primary: HitMeta, secondary: HitMeta): HitMeta {
  const defined = (meta: HitMeta) => Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
  return { ...defined(secondary), ...defined(primary) };
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function isPaperLike(result: FusedResult): boolean {
  return result.meta.year !== undefined || !!result.meta.authors?.length || !!result.meta.doi;
}

/** Whole-title key for papers: no site-suffix stripping, since subtitles often contain " - ". */
export function paperTitleKey(title: string): string {
  return title.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

/**
 * The same paper reached through different URLs (publisher page, arXiv, DOI, repository mirror):
 * identical long title, compatible year, and both sides carrying academic metadata.
 */
function samePaper(left: FusedResult, right: FusedResult): boolean {
  if (!isPaperLike(left) || !isPaperLike(right)) return false;
  const key = paperTitleKey(left.title);
  if (key.length < 20 || key !== paperTitleKey(right.title)) return false;
  return left.meta.year === undefined || right.meta.year === undefined || left.meta.year === right.meta.year;
}

/** Fold `source` into `target`: union of source ranks, summed RRF, richest text and metadata. */
function absorb(target: FusedResult, source: FusedResult, weights: Weights, k: number): void {
  for (const entry of source.sources) {
    if (target.sources.some((existing) => existing.source === entry.source)) continue;
    target.sources.push({ ...entry });
    target.rrfScore += (weights[entry.source] ?? 1) / (k + entry.rank);
  }
  target.host ??= source.host;
  if (source.snippet.length > target.snippet.length) target.snippet = source.snippet;
  if (!target.title && source.title) target.title = source.title;
  if (source.content && (!target.content || source.content.length > target.content.length)) {
    target.content = source.content;
  }
  target.publishedAt ??= source.publishedAt;
  target.meta = mergeMeta(target.meta, source.meta);
  if (source.image) target.image = target.image ? { ...source.image, ...definedOnly(target.image) } : source.image;
  if (source.video) target.video = target.video ? { ...source.video, ...definedOnly(target.video) } : source.video;
  if (source.note) target.note = target.note ? { ...source.note, ...definedOnly(target.note) } : source.note;
  const citations = Math.max(target.meta.citations ?? 0, source.meta.citations ?? 0);
  if (citations) target.meta.citations = citations;
}

/** Sites that mostly republish: when the same article is found on one of these and elsewhere, the other copy is shown. */
const REPRINT_HOSTS = ['csdn.net', 'cnblogs.com', 'jianshu.com', 'sohu.com', 'baijiahao.baidu.com', 'mbd.baidu.com', 'toutiao.com', '163.com', '51cto.com', '360doc.com', 'sina.com.cn', 'sina.cn'];
const isReprintHost = (host: string) => REPRINT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/** "标题_CSDN博客", "标题 - 知乎", "Title | Site" → the title part; a title with no separator is returned whole. */
function articleTitleKey(title: string): string {
  const head = title.split(/\s[-–—|｜]\s|[_｜|]/)[0] ?? title;
  return paperTitleKey(head);
}

const bigrams = (text: string): Set<string> => {
  const flat = text.toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
  const out = new Set<string>();
  for (let i = 0; i < flat.length - 1; i++) out.add(flat.slice(i, i + 2));
  return out;
};

/** How much of the shorter text's two-character pieces appear in the longer one: ~1 for the same text, ~0.1 for unrelated text. */
function overlap(left: string, right: string): number {
  const [a, b] = [bigrams(left), bigrams(right)].sort((x, y) => x.size - y.size);
  if (a.size < 20) return 0; // too little text to tell
  let shared = 0;
  for (const piece of a) if (b.has(piece)) shared++;
  return shared / a.size;
}

function reprintable(result: FusedResult): boolean {
  return !result.image && !result.video && !result.note && !isPaperLike(result);
}

function hostOfResult(result: FusedResult): string {
  if (result.host) return result.host.replace(/^www\./, '');
  try {
    return new URL(result.url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The same article posted on several sites (a WeChat article copied to CSDN and Zhihu) is one result: the copy that is
 * probably the original is kept (not a republishing site, then the earliest date, then the best rank), the others are
 * listed under it as `reprints`. Deliberately conservative: same title, different sites, AND the texts the engines showed
 * overlap, so two different posts that happen to share a title stay apart. Keeps the order of the list.
 */
export function foldReprints(results: FusedResult[]): FusedResult[] {
  const groups = new Map<string, FusedResult[]>();
  for (const result of results) {
    if (!reprintable(result)) continue;
    const key = articleTitleKey(result.title);
    if (key.length < 12) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(result);
    groups.set(key, bucket);
  }
  const drop = new Set<FusedResult>();
  const replace = new Map<FusedResult, FusedResult>();
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    // Members of one reprint family: a different site and a text that overlaps the first one's.
    const family = [bucket[0]];
    for (const other of bucket.slice(1)) {
      const text = other.content || other.snippet;
      if (family.some((member) => hostOfResult(member) !== hostOfResult(other) && overlap(member.content || member.snippet, text) >= 0.5)) family.push(other);
    }
    if (family.length < 2) continue;
    const rank = (r: FusedResult) => results.indexOf(r);
    const primary = [...family].sort((a, b) => {
      const aggregator = Number(isReprintHost(hostOfResult(a))) - Number(isReprintHost(hostOfResult(b)));
      if (aggregator) return aggregator;
      if (a.publishedAt && b.publishedAt && a.publishedAt !== b.publishedAt) return a.publishedAt < b.publishedAt ? -1 : 1;
      return rank(a) - rank(b);
    })[0];
    const others = family.filter((r) => r !== primary);
    const best = Math.min(...family.map(rank));
    const folded: FusedResult = { ...primary, rrfScore: Math.max(...family.map((r) => r.rrfScore)), reprints: [...(primary.reprints ?? []), ...others.map((r) => ({ url: r.url, host: hostOfResult(r) }))] };
    // The folded result takes the best-ranked member's place; the other members go.
    replace.set(results[best], folded);
    for (const member of family) if (member !== results[best]) drop.add(member);
  }
  if (!replace.size && !drop.size) return results;
  const out: FusedResult[] = [];
  for (const result of results) {
    const swap = replace.get(result);
    if (swap) out.push(swap);
    else if (!drop.has(result)) out.push(result);
  }
  return out;
}

/**
 * Merge per-source ranked lists with Reciprocal Rank Fusion:
 * score(d) = sum_s w_s / (k + rank_s(d)).
 */
export function fuse(lists: SearchHit[][], weights: Weights = {}, k = RRF_K): FusedResult[] {
  const byKey = new Map<string, FusedResult>();
  for (const list of lists) {
    for (const hit of list) {
      if (!hit.url || !/^https?:/i.test(hit.url)) continue;
      if (hit.image && !/^https?:/i.test(hit.image.src)) continue;
      // The same picture shows up under different pages, so images are identified by their file.
      const key = hit.image ? `img:${normalizeUrl(hit.image.src)}` : normalizeUrl(hit.url);
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
          ...(hit.image ? { image: hit.image } : {}),
          ...(hit.video ? { video: hit.video } : {}),
          ...(hit.note ? { note: hit.note } : {}),
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
      existing.meta = mergeMeta(existing.meta, hit.meta ?? {});
      if (hit.image) existing.image = existing.image ? { ...hit.image, ...definedOnly(existing.image) } : hit.image;
      if (hit.video) existing.video = existing.video ? { ...hit.video, ...definedOnly(existing.video) } : hit.video;
      if (hit.note) existing.note = existing.note ? { ...hit.note, ...definedOnly(existing.note) } : hit.note;
    }
  }
  const values = [...byKey.values()];
  const wrappers = values.filter((result) => isGoogleGotoUrl(result.url));
  const results = values.filter((result) => !isGoogleGotoUrl(result.url));
  for (const wrapper of wrappers) {
    const match = results.find((result) => matchesWrapperPair(wrapper, result));
    if (match) absorb(match, wrapper, weights, k);
    else results.push(wrapper);
  }
  results.sort((a, b) => b.rrfScore - a.rrfScore);
  const deduped: FusedResult[] = [];
  for (const result of results) {
    const twin = deduped.find((kept) => samePaper(kept, result));
    if (twin) absorb(twin, result, weights, k);
    else deduped.push(result);
  }
  const folded = foldReprints(deduped);
  folded.sort((a, b) => b.rrfScore - a.rrfScore);
  const max = folded[0]?.rrfScore ?? 1;
  for (const r of folded) r.score = r.rrfScore / max;
  return folded;
}

export function mergeLateHits(
  results: FusedResult[],
  hits: SearchHit[],
  weights: Weights = {},
  k = RRF_K,
): FusedResult[] {
  const merged = results.map((result) => ({
    ...result,
    sources: result.sources.map((source) => ({ ...source })),
    meta: { ...result.meta },
  }));
  for (const late of fuse([hits], weights, k)) {
    const existing = merged.find(
      (result) => result.key === late.key || matchesWrapperPair(result, late) || samePaper(result, late),
    );
    if (!existing) {
      merged.push({ ...late, late: true, score: 0 });
      continue;
    }
    absorb(existing, late, weights, k);
  }
  return foldReprints(merged);
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
