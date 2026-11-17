import type { FusionConfig, SourceId } from '@kiwi-search/core';
import { SOURCE_INFO } from './sourceCatalog';

/** What one request to a source's site found: it answered, it could not be reached at all, or it answered with a block or a check. */
export type Reach = 'ok' | 'unreachable' | 'limited';

/**
 * The address each source is checked at during onboarding: a small, stable page on the host the source actually searches (its
 * icon, or the root of its API). Typed over `SourceId`, so a new source cannot be left out; `null` for one with no fixed host
 * (SearXNG is the user's own server).
 */
export const PROBE_URLS: Record<SourceId, string | null> = {
  google: 'https://www.google.com/generate_204',
  bing: 'https://www.bing.com/favicon.ico',
  duckduckgo: 'https://duckduckgo.com/favicon.ico',
  bravesearch: 'https://search.brave.com/favicon.ico',
  kagi: 'https://kagi.com/favicon.ico',
  baidu: 'https://www.baidu.com/favicon.ico',
  sogou: 'https://www.sogou.com/favicon.ico',
  yuanbao: 'https://so.qq.com/',
  yandex: 'https://yandex.com/favicon.ico',
  brave: 'https://api.search.brave.com/',
  exa: 'https://api.exa.ai/',
  deepseek: 'https://api.deepseek.com/',
  searxng: null,
  taobao: 'https://www.taobao.com/favicon.ico',
  jd: 'https://www.jd.com/favicon.ico',
  amazon: 'https://www.amazon.com/favicon.ico',
  xianyu: 'https://www.goofish.com/',
  scholar: 'https://scholar.google.com/favicon.ico',
  openalex: 'https://api.openalex.org/',
  arxiv: 'https://export.arxiv.org/',
  pubmed: 'https://eutils.ncbi.nlm.nih.gov/',
  europepmc: 'https://www.ebi.ac.uk/',
  dblp: 'https://dblp.org/',
  baiduxueshu: 'https://xueshu.baidu.com/',
  cnki: 'https://kns.cnki.net/',
  wos: 'https://www.webofscience.com/',
  crossref: 'https://api.crossref.org/',
  youtube: 'https://www.youtube.com/favicon.ico',
  bilibili: 'https://www.bilibili.com/favicon.ico',
  douyin: 'https://www.douyin.com/',
  zhihu: 'https://www.zhihu.com/favicon.ico',
  weixin: 'https://weixin.sogou.com/',
  rednote: 'https://www.rednote.com/',
  xiaohongshu: 'https://www.xiaohongshu.com/',
  x: 'https://x.com/favicon.ico',
  openverse: 'https://api.openverse.org/',
};

/**
 * Any answer means the site can be reached, a redirect included (it is not followed: the target is often a CDN host whose
 * reachability says nothing about the search page). A refusal or a region block means reachable but limited.
 */
export function classifyResponse(status: number): Reach {
  return status === 403 || status === 429 || status === 451 ? 'limited' : 'ok';
}

export interface ProbeResult {
  reach: Reach;
  ms: number;
}

/**
 * One request per source, all at once, each given up after `timeoutMs`. No cookies, no cache: the answer says whether the site can
 * be reached from this browser's network, not whether the user is signed in. A body is never read.
 */
export async function probeSources(
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  ids: SourceId[],
  opts: { timeoutMs?: number; signal?: AbortSignal; onResult?: (id: SourceId, result: ProbeResult) => void } = {},
): Promise<Partial<Record<SourceId, ProbeResult>>> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const out: Partial<Record<SourceId, ProbeResult>> = {};
  await Promise.all(ids.map(async (id) => {
    const url = PROBE_URLS[id];
    if (!url) return;
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const stop = () => ctrl.abort();
    opts.signal?.addEventListener('abort', stop, { once: true });
    let reach: Reach;
    try {
      const res = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'manual', referrerPolicy: 'no-referrer', signal: ctrl.signal });
      // A redirect not followed comes back as an `opaqueredirect` with status 0: the site answered.
      reach = res.type === 'opaqueredirect' ? 'ok' : classifyResponse(res.status);
      void res.body?.cancel().catch(() => {});
    } catch {
      // A timeout, a reset connection or a name that does not resolve all look the same from here.
      reach = 'unreachable';
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
    }
    if (opts.signal?.aborted) return;
    out[id] = { reach, ms: Date.now() - started };
    opts.onResult?.(id, out[id]!);
  }));
  return out;
}

/** The web engines that can stand in when the usual ones cannot be reached. Never Baidu: it stays off unless the user insists. */
export const WEB_ALTERNATIVES: SourceId[] = ['sogou', 'yuanbao', 'yandex'];

/** A web source that works without a key or server address: a browser engine. */
const keyless = (id: SourceId) => !SOURCE_INFO[id].key && !SOURCE_INFO[id].baseUrl;

export interface ProbePlan {
  /** Switched on and could not be reached: switched off. */
  turnOff: SourceId[];
  /** Keyless web engines still on and reachable after `turnOff`. */
  webLeft: SourceId[];
  /** Reachable alternatives that are off, offered (never switched on) when fewer than two keyless web engines are left. */
  suggest: SourceId[];
}

/**
 * What to change after the check. It only ever switches sources off: one that is off by default (Kagi, Baidu, Sogou …) stays off
 * however the check went, and the user can still switch anything back on. Sources the user already changed by hand are left alone.
 */
export function planFromProbe(config: FusionConfig, results: Partial<Record<SourceId, ProbeResult>>, touched: ReadonlySet<SourceId> = new Set()): ProbePlan {
  const ids = Object.keys(results) as SourceId[];
  const turnOff = ids.filter((id) => !touched.has(id) && config.sources[id]?.enabled && results[id]!.reach === 'unreachable');
  const on = (id: SourceId) => !!config.sources[id]?.enabled && !turnOff.includes(id);
  const webLeft = (Object.keys(SOURCE_INFO) as SourceId[]).filter((id) => SOURCE_INFO[id].group === 'web' && keyless(id) && on(id) && results[id]?.reach !== 'unreachable');
  const suggest = webLeft.length < 2 ? WEB_ALTERNATIVES.filter((id) => !config.sources[id]?.enabled && results[id] && results[id]!.reach !== 'unreachable') : [];
  return { turnOff, webLeft, suggest };
}
