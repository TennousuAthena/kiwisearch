import { fetchText } from './http';
import { htmlToText } from './text';
import type { Env, FusedResult, FusionConfig } from './types';

/** Fill in page text for results that don't already carry content. */
export async function fetchContents(
  results: FusedResult[],
  config: FusionConfig,
  env: Env,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const { contentFetcher, maxCharsPerSource, jinaApiKey } = config.summary;
  const out = new Map<string, string>();
  await Promise.all(
    results.map(async (r) => {
      if (r.content && r.content.length > 400) {
        out.set(r.key, r.content.slice(0, maxCharsPerSource));
        return;
      }
      if (contentFetcher === 'none') return;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
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
        if (text.trim().length > 100) out.set(r.key, text.slice(0, maxCharsPerSource));
      } catch {
        /* fall back to snippet */
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return out;
}
