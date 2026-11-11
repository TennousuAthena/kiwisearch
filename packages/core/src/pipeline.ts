import { DEFAULT_CONFIG, usableSources } from './config';
import { fetchContents } from './content';
import { applyRerank, fuse, mergeLateHits } from './fusion';
import { errorMessage } from './http';
import { chatStream, llmConfigured } from './llm';
import { rerank } from './rerank';
import { SOURCES } from './sources';
import { buildCitations, buildSummaryMessages } from './summarize';
import type { Env, FusedResult, FusionConfig, PipelineEvent, PipelineResult, RunOptions, SearchHit, SourceId } from './types';

type SourceOutcome =
  | { kind: 'done'; hits: SearchHit[]; ms: number }
  | { kind: 'error'; error: string; ms: number };

export async function runSearch(
  query: string,
  config: FusionConfig = DEFAULT_CONFIG,
  env: Env,
  opts: RunOptions = {},
): Promise<PipelineResult> {
  const signal = opts.signal;
  const emit = (e: PipelineEvent) => {
    if (!signal?.aborted) opts.onEvent?.(e);
  };
  query = query.trim();
  if (!query) throw new Error('empty query');
  signal?.throwIfAborted();

  const active = usableSources(config, !!env.runBrowserEngine)
    .filter((s) => !s.reason && (!opts.sources || opts.sources.includes(s.id)))
    .map((s) => s.id);
  if (!active.length) throw new Error('No usable search sources. Enable at least one source (and add API keys) in settings.');

  const sourceStats: PipelineResult['sourceStats'] = [];
  const weights = Object.fromEntries(active.map((id) => [id, config.sources[id]?.weight ?? 1])) as Partial<Record<SourceId, number>>;
  let currentResults: FusedResult[] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const waitForDoneOrAbort = async (): Promise<boolean> => {
    if (signal?.aborted) return false;
    if (!signal) {
      await done;
      return true;
    }
    let onAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    if (signal.aborted) onAbort();
    await Promise.race([done, aborted]);
    signal.removeEventListener('abort', onAbort);
    return !signal.aborted;
  };
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
      let resolveBlocked!: () => void;
      const blockedSignal = new Promise<void>((resolve) => {
        resolveBlocked = resolve;
      });
      const onBlocked = (message: string) => {
        if (blocked || signal?.aborted) return;
        blocked = true;
        clearTimeout(timer);
        timeoutMs = 120000;
        timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
        emit({ type: 'source_blocked', source: id, message });
        resolveBlocked();
      };
      const task: Promise<SourceOutcome> = (async () => {
        try {
          const hits = await SOURCES[id].search(query, {
            env,
            settings: config.sources[id]!,
            count: config.perSourceCount,
            signal: controller.signal,
            onBlocked,
          });
          return { kind: 'done', hits, ms: Date.now() - started };
        } catch (e) {
          const error = controller.signal.aborted && !signal?.aborted ? `timeout after ${timeoutMs}ms` : errorMessage(e);
          return { kind: 'error', error, ms: Date.now() - started };
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', parentAbort);
        }
      })();
      const raced = await Promise.race([
        task.then((outcome) => ({ kind: 'finished' as const, outcome })),
        blockedSignal.then(() => ({ kind: 'blocked' as const })),
      ]);
      if (raced.kind === 'blocked' || blocked) {
        sourceStats.push({ source: id, count: 0, ms: Date.now() - started, status: 'blocked' });
        void task.then(async (outcome) => {
          if (!(await waitForDoneOrAbort()) || signal?.aborted) return;
          if (outcome.kind === 'error') {
            emit({ type: 'source_error', source: id, error: outcome.error, ms: outcome.ms });
            return;
          }
          emit({ type: 'source_done', source: id, count: outcome.hits.length, ms: outcome.ms });
          if (signal?.aborted) return;
          currentResults = mergeLateHits(currentResults, outcome.hits, weights);
          emit({ type: 'late_results', source: id, results: currentResults });
        });
        return [];
      }
      if (raced.kind !== 'finished') return [];
      const outcome = raced.outcome;
      if (outcome.kind === 'error') {
        sourceStats.push({ source: id, count: 0, ms: outcome.ms, error: outcome.error });
        emit({ type: 'source_error', source: id, error: outcome.error, ms: outcome.ms });
        return [];
      }
      sourceStats.push({ source: id, count: outcome.hits.length, ms: outcome.ms });
      emit({ type: 'source_done', source: id, count: outcome.hits.length, ms: outcome.ms });
      return outcome.hits;
    }),
  );
  signal?.throwIfAborted();

  let results: FusedResult[] = fuse(lists, weights);
  emit({ type: 'fused', results });

  const provider = config.rerank.provider;
  const canRerank =
    provider !== 'none' && results.length > 1 && (provider === 'llm' ? llmConfigured(config.llm) && !!config.llm.apiKey : !!config.rerank.apiKey);
  if (canRerank) {
    const candidates = results.slice(0, config.rerank.candidates);
    try {
      const scores = await rerank(query, candidates, config, env, signal);
      signal?.throwIfAborted();
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
  if (wantSummary && results.length && config.summary.provider === 'chrome-builtin') {
    const top = results.slice(0, config.summary.maxSources);
    const citations = buildCitations(top);
    result.citations = citations;
    const contents = await fetchContents(top, config, env, signal);
    signal?.throwIfAborted();
    const messages = buildSummaryMessages(query, top, contents, config.summary.instructions);
    emit({ type: 'summary_prompt', citations, messages });
  } else if (wantSummary && results.length && llmConfigured(config.llm) && config.llm.apiKey) {
    const top = results.slice(0, config.summary.maxSources);
    const citations = buildCitations(top);
    result.citations = citations;
    emit({ type: 'summary_start', citations });
    try {
      const contents = await fetchContents(top, config, env, signal);
      signal?.throwIfAborted();
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

  signal?.throwIfAborted();
  currentResults = results;
  emit({ type: 'done', result });
  resolveDone();
  return result;
}
