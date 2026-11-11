import { fetchJson } from './http';
import { chat, extractJson } from './llm';
import { truncate } from './text';
import type { Env, FusedResult, FusionConfig } from './types';

function docText(r: FusedResult, max = 600): string {
  return truncate(`${r.title}\n${r.snippet || r.content || ''}`.replace(/\s+/g, ' '), max);
}

function normalize(scores: number[]): number[] {
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (max - min < 1e-9) return scores.map(() => 1);
  return scores.map((s) => (s - min) / (max - min));
}

/**
 * Returns relevance in [0,1] keyed by FusedResult.key for the given candidates.
 */
export async function rerank(
  query: string,
  candidates: FusedResult[],
  config: FusionConfig,
  env: Env,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const { provider, apiKey, model } = config.rerank;
  const out = new Map<string, number>();
  if (!candidates.length || provider === 'none') return out;

  if (provider === 'jina' || provider === 'cohere') {
    const isJina = provider === 'jina';
    const url = isJina ? 'https://api.jina.ai/v1/rerank' : 'https://api.cohere.com/v2/rerank';
    const data = await fetchJson<{ results: { index: number; relevance_score: number }[] }>(env.fetch, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey ?? ''}` },
      body: JSON.stringify({
        model: model || (isJina ? 'jina-reranker-v2-base-multilingual' : 'rerank-v3.5'),
        query,
        documents: candidates.map((c) => docText(c, 1500)),
        top_n: candidates.length,
      }),
      signal,
    });
    // Both APIs already return scores in [0,1].
    for (const r of data.results) {
      const c = candidates[r.index];
      if (c) out.set(c.key, r.relevance_score);
    }
    return out;
  }

  // LLM listwise-ish scoring: ask for a 0-10 relevance per document.
  const docs = candidates.map((c, i) => `[${i}] ${docText(c, 400)}`).join('\n');
  const reply = await chat(
    env.fetch,
    config.llm,
    [
      {
        role: 'system',
        content:
          'You are a search result reranker. Score how well each document answers the query on a 0-10 scale ' +
          '(10 = directly and authoritatively answers it, 0 = irrelevant/spam). ' +
          'Reply with JSON only: {"scores": [{"i": <index>, "s": <score>}, ...]} covering every index.',
      },
      { role: 'user', content: `Query: ${query}\n\nDocuments:\n${docs}` },
    ],
    { signal, json: true },
  );
  const parsed = extractJson<{ scores?: { i: number; s: number }[] } | { i: number; s: number }[]>(reply);
  const list = Array.isArray(parsed) ? parsed : (parsed?.scores ?? []);
  const valid = list.filter((x) => typeof x?.i === 'number' && typeof x?.s === 'number' && candidates[x.i]);
  if (!valid.length) throw new Error('LLM reranker returned no parsable scores');
  const norm = normalize(valid.map((x) => Math.max(0, Math.min(10, x.s)) / 10));
  valid.forEach((x, j) => out.set(candidates[x.i].key, norm[j]));
  return out;
}
