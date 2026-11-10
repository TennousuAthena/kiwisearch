import { DEFAULT_CONFIG, usableSources } from './config';
import { fetchContents } from './content';
import { applyRerank, fuse } from './fusion';
import { errorMessage } from './http';
import { chatStream, llmConfigured } from './llm';
import { rerank } from './rerank';
import { SOURCES } from './sources';
import { buildCitations, buildSummaryMessages } from './summarize';
import type { Env, FusedResult, FusionConfig, PipelineEvent, PipelineResult, RunOptions, SearchHit, SourceId } from './types';

export async function runSearch(
  query: string,
  config: FusionConfig = DEFAULT_CONFIG,
  env: Env,
  opts: RunOptions = {},
): Promise<PipelineResult> {
  const emit = (e: PipelineEvent) => opts.onEvent?.(e);
  const signal = opts.signal;
  query = query.trim();
  if (!query) throw new Error('empty query');

  const active = usableSources(config, !!env.runBrowserEngine)
    .filter((s) => !s.reason && (!opts.sources || opts.sources.includes(s.id)))
    .map((s) => s.id);
  if (!active.length) throw new Error('No usable search sources. Enable at least one source (and add API keys) in settings.');

  const sourceStats: PipelineResult['sourceStats'] = [];
  const lists = await Promise.all(
    active.map(async (id): Promise<SearchHit[]> => {
      const started = Date.now();
      emit({ type: 'source_start', source: id });
      const controller = new AbortController();
      let timeoutMs = config.sourceTimeoutMs;
      let blocked = false;
      let timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      const parentAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', parentAbort, { once: true });
      if (signal?.aborted) parentAbort();
      const onBlocked = (message: string) => {
        emit({ type: 'source_blocked', source: id, message });
        if (blocked) return;
        blocked = true;
        clearTimeout(timer);
        timeoutMs = 120000;
        timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
      };
      try {
        const hits = await SOURCES[id].search(query, {
          env,
          settings: config.sources[id]!,
          count: config.perSourceCount,
          signal: controller.signal,
          onBlocked,
        });
        const ms = Date.now() - started;
        sourceStats.push({ source: id, count: hits.length, ms });
        emit({ type: 'source_done', source: id, count: hits.length, ms });
        return hits;
      } catch (e) {
        const ms = Date.now() - started;
        const error = controller.signal.aborted && !signal?.aborted ? `timeout after ${timeoutMs}ms` : errorMessage(e);
        sourceStats.push({ source: id, count: 0, ms, error });
        emit({ type: 'source_error', source: id, error, ms });
        return [];
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', parentAbort);
      }
    }),
  );
  signal?.throwIfAborted();

  const weights = Object.fromEntries(active.map((id) => [id, config.sources[id]?.weight ?? 1])) as Partial<Record<SourceId, number>>;
  let results: FusedResult[] = fuse(lists, weights);
  emit({ type: 'fused', results });

  const provider = config.rerank.provider;
  const canRerank =
    provider !== 'none' && results.length > 1 && (provider === 'llm' ? llmConfigured(config.llm) && !!config.llm.apiKey : !!config.rerank.apiKey);
  if (canRerank) {
    const candidates = results.slice(0, config.rerank.candidates);
    try {
      const scores = await rerank(query, candidates, config, env, signal);
      results = [...applyRerank(candidates, scores), ...results.slice(candidates.length).map((r) => ({ ...r, score: r.score * 0.25 }))];
      emit({ type: 'reranked', results, provider });
    } catch (e) {
      if (signal?.aborted) throw e;
      emit({ type: 'reranked', results, provider, error: errorMessage(e) });
    }
  }

  const limited = opts.limit ? results.slice(0, opts.limit) : results;
  const result: PipelineResult = { query, results: limited, citations: [], sourceStats };

  const wantSummary = opts.summarize ?? config.summary.enabled;
  if (wantSummary && results.length && config.summary.provider === 'chrome-builtin' && llmConfigured(config.llm)) {
    const top = results.slice(0, config.summary.maxSources);
    const citations = buildCitations(top);
    result.citations = citations;
    const contents = await fetchContents(top, config, env, signal);
    const messages = buildSummaryMessages(query, top, contents, config.summary.instructions);
    emit({ type: 'summary_prompt', citations, messages });
  } else if (wantSummary && results.length && llmConfigured(config.llm) && config.llm.apiKey) {
    const top = results.slice(0, config.summary.maxSources);
    const citations = buildCitations(top);
    result.citations = citations;
    emit({ type: 'summary_start', citations });
    try {
      const contents = await fetchContents(top, config, env, signal);
      const messages = buildSummaryMessages(query, top, contents, config.summary.instructions);
      let text = '';
      for await (const delta of chatStream(env.fetch, config.llm, messages, { signal })) {
        text += delta;
        emit({ type: 'summary_delta', text: delta });
      }
      result.summary = text;
      emit({ type: 'summary_done', text });
    } catch (e) {
      if (signal?.aborted) throw e;
      emit({ type: 'summary_error', error: errorMessage(e) });
    }
  }

  emit({ type: 'done', result });
  return result;
}
