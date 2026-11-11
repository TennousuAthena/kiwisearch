import { fetchText } from './http';
import { htmlToText } from './text';
import { isGoogleGotoUrl } from './engines/google';
import type { Env, FusedResult, FusionConfig } from './types';

const CONTENT_FETCH_DEADLINE_MS = 12000;
/** Pages a plain fetch cannot use (a login wall, or Sogou's redirect interstitial), so the result's own excerpt is used. */
const LOGIN_ONLY_HOST = /(^|\.)(zhihu|xiaohongshu|rednote|sogou)\.com$/;

function isLoginOnly(url: string): boolean {
  try {
    return LOGIN_ONLY_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Fill in page text for results that don't already carry content. */
export async function fetchContents(
  results: FusedResult[],
  config: FusionConfig,
  env: Env,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const { contentFetcher, maxCharsPerSource, jinaApiKey } = config.summary;
  const out = new Map<string, string>();
  const overall = new AbortController();
  const abortOverall = () => overall.abort(signal?.reason);
  signal?.addEventListener('abort', abortOverall, { once: true });
  if (signal?.aborted) abortOverall();
  let resolveAborted!: () => void;
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });
  const onAbort = () => resolveAborted();
  overall.signal.addEventListener('abort', onAbort, { once: true });
  if (overall.signal.aborted) onAbort();
  const deadline = setTimeout(
    () => overall.abort(new Error('content fetch deadline exceeded')),
    CONTENT_FETCH_DEADLINE_MS,
  );
  const tasks = results.map(async (r) => {
    if (overall.signal.aborted || isGoogleGotoUrl(r.url) || isLoginOnly(r.url)) return;
    if (r.content && r.content.length > 400) {
      out.set(r.key, r.content.slice(0, maxCharsPerSource));
      return;
    }
    if (contentFetcher === 'none') return;
    const ctrl = new AbortController();
    const abort = () => ctrl.abort(overall.signal.reason);
    overall.signal.addEventListener('abort', abort, { once: true });
    if (overall.signal.aborted) abort();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      let text: string;
      if (contentFetcher === 'jina') {
        text = await fetchText(env.fetch, `https://r.jina.ai/${r.url}`, {
          signal: ctrl.signal,
          headers: { Accept: 'text/plain', 'X-Retain-Images': 'none', ...(jinaApiKey ? { Authorization: `Bearer ${jinaApiKey}` } : {}) },
        });
      } else {
        const res = await env.fetch(r.url, { signal: ctrl.signal, headers: { Accept: 'text/html,application/xhtml+xml' } });
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok || !/html|text\/plain/.test(type)) return;
        const body = await res.text();
        text = type.includes('html') ? htmlToText(body, maxCharsPerSource).text : body;
      }
      if (!overall.signal.aborted && text.trim().length > 100) out.set(r.key, text.slice(0, maxCharsPerSource));
    } catch {
      /* fall back to snippet */
    } finally {
      clearTimeout(timer);
      overall.signal.removeEventListener('abort', abort);
    }
  });
  try {
    await Promise.race([Promise.all(tasks), aborted]);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abortOverall);
    overall.signal.removeEventListener('abort', onAbort);
  }
  return out;
}
