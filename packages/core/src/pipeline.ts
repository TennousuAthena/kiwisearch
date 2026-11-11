import { DEFAULT_CONFIG, resultCount, sourcesForRoutes, usableSources } from './config';
import { fetchContents } from './content';
import { applyRerank, fuse, mergeLateHits } from './fusion';
import { errorMessage } from './http';
import { judgeIntent } from './intent';
import { applyDomainRules, applyJudgments, flagInjectedContents, judgeEnabled, judgeResults } from './judge';
import { chatStream, llmUsable } from './llm';
import { rerank } from './rerank';
import { SOURCES } from './sources';
import { buildCitations, buildSummaryMessages } from './summarize';
import { modeHasText } from './types';
import type { BlockReason, Env, FusedResult, FusionConfig, PipelineEvent, PipelineResult, RunOptions, SearchHit, SourceId } from './types';

/** How long a browser source may sit behind other requests for its engine before it counts as stuck. */
const QUEUE_WAIT_MS = 60_000;
const BLOCKED_TIMEOUT_MS = 120_000;

type SourceOutcome =
  | { kind: 'done'; hits: SearchHit[]; ms: number }
  | { kind: 'error'; error: string; ms: number };

interface SourceRun {
  id: SourceId;
  started: number;
  /** Settles with the outcome; never rejects. */
  task: Promise<SourceOutcome>;
  /** Resolves if the source reports a captcha or block page. */
  blocked: Promise<void>;
  wasBlocked: () => boolean;
  blockedReason: () => BlockReason;
}

export async function runSearch(
  query: string,
  config: FusionConfig = DEFAULT_CONFIG,
  env: Env,
  opts: RunOptions = {},
): Promise<PipelineResult> {
  const signal = opts.signal;
  const mode = opts.mode ?? 'web';
  const emit = (e: PipelineEvent) => {
    if (!signal?.aborted) opts.onEvent?.(e);
  };
  query = query.trim();
  if (!query) throw new Error('empty query');
  signal?.throwIfAborted();

  const baseSources = usableSources(config, !!env.runBrowserEngine, mode)
    .filter((s) => !s.reason && (!opts.sources || opts.sources.includes(s.id)))
    .map((s) => s.id);
  if (!baseSources.length) {
    throw new Error(
      mode === 'web'
        ? 'No usable search sources. Enable at least one source (and add API keys) in settings.'
        : `No usable sources for ${mode} search. Enable one in settings.`,
    );
  }

  const sourceStats: PipelineResult['sourceStats'] = [];
  const recordStat = (stat: PipelineResult['sourceStats'][number]) => {
    const index = sourceStats.findIndex((existing) => existing.source === stat.source);
    if (index >= 0) sourceStats[index] = stat;
    else sourceStats.push(stat);
  };
  // Sources that are running or done. It grows when the decision model switches more on mid-search.
  const active: SourceId[] = [];
  const weights: Partial<Record<SourceId, number>> = {};
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

  const startSource = (id: SourceId): SourceRun => {
    const source = SOURCES[id];
    const started = Date.now();
    emit({ type: 'source_start', source: id });
    // A source started for a routed intent runs in its own mode (Zhihu inside a general search, say): its own URL, count and cache.
    const sourceMode = source.modes.includes(mode) ? mode : source.modes[0];
    const count = resultCount(config, sourceMode);
    const cacheKey = `${sourceMode}|${id}|${count}|${query.toLowerCase()}`;
    const cached = env.cache?.get(cacheKey);
    if (cached) {
      return {
        id,
        started,
        task: Promise.resolve({ kind: 'done', hits: cached, ms: 0 }),
        blocked: new Promise<void>(() => {}),
        wasBlocked: () => false,
        blockedReason: () => 'captcha',
      };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, message: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(message)), ms);
    };
    // Browser sources queue per engine; their timeout runs from `onStart`, not from enqueueing.
    let working = !source.requiresBrowser;
    if (working) arm(config.sourceTimeoutMs, `timeout after ${config.sourceTimeoutMs}ms`);
    else arm(QUEUE_WAIT_MS, `still queued after ${QUEUE_WAIT_MS}ms`);
    const onStart = () => {
      if (working || blocked) return;
      working = true;
      arm(config.sourceTimeoutMs, `timeout after ${config.sourceTimeoutMs}ms`);
    };

    const parentAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', parentAbort, { once: true });
    if (signal?.aborted) parentAbort();

    let blocked = false;
    let blockedReason: BlockReason = 'captcha';
    let resolveBlocked!: () => void;
    const blockedSignal = new Promise<void>((resolve) => {
      resolveBlocked = resolve;
    });
    const onBlocked = (message: string, reason: BlockReason = 'captcha') => {
      if (blocked || signal?.aborted) return;
      blocked = true;
      blockedReason = reason;
      arm(BLOCKED_TIMEOUT_MS, `timeout after ${BLOCKED_TIMEOUT_MS}ms`);
      emit({ type: 'source_blocked', source: id, message, reason });
      resolveBlocked();
    };

    const task = (async (): Promise<SourceOutcome> => {
      try {
        const hits = await source.search(query, {
          env,
          settings: config.sources[id]!,
          mode: sourceMode,
          count,
          signal: controller.signal,
          onBlocked,
          onStart,
          renderer: config.renderer,
        });
        if (hits.length) env.cache?.set(cacheKey, hits);
        return { kind: 'done', hits, ms: Date.now() - started };
      } catch (e) {
        const error = controller.signal.aborted && !signal?.aborted ? errorMessage(controller.signal.reason) : errorMessage(e);
        return { kind: 'error', error, ms: Date.now() - started };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', parentAbort);
      }
    })();
    return { id, started, task, blocked: blockedSignal, wasBlocked: () => blocked, blockedReason: () => blockedReason };
  };

  /** Merge one late source into the finished results; judged like the rest when the decision model is on. */
  const mergeLate = async (run: SourceRun, outcome: SourceOutcome) => {
    if (outcome.kind === 'error') {
      emit({ type: 'source_error', source: run.id, error: outcome.error, ms: outcome.ms });
      return;
    }
    emit({ type: 'source_done', source: run.id, count: outcome.hits.length, ms: outcome.ms });
    if (signal?.aborted) return;
    let merged = applyDomainRules(mergeLateHits(currentResults, outcome.hits, weights), config.judge);
    if (judgeEnabled(config.judge)) {
      const unjudged = merged.filter((r) => !r.judgment && !r.hidden).slice(0, config.judge.candidates);
      if (unjudged.length) {
        try {
          const { judgments } = await judgeResults(query, unjudged, config, env, signal);
          if (judgments.size) merged = applyJudgments(merged, judgments, config.judge);
        } catch (e) {
          if (signal?.aborted) return;
        }
      }
    }
    if (signal?.aborted) return;
    currentResults = merged;
    emit({ type: 'late_results', source: run.id, results: currentResults });
  };

  /** Late sources (blocked, or still running past the soft deadline) report after `done` and merge in. */
  let lateQueue: Promise<void> = Promise.resolve();
  const deferLate = (run: SourceRun) => {
    void run.task.then(async (outcome) => {
      if (!(await waitForDoneOrAbort()) || signal?.aborted) return;
      // One at a time: each merge reads the results the previous one wrote.
      lateQueue = lateQueue.then(() => mergeLate(run, outcome)).catch(() => {});
    });
  };

  const hitsBySource = new Map<SourceId, SearchHit[]>();
  const settled = new Set<SourceId>();
  const collected = () => active.map((id) => hitsBySource.get(id) ?? []);
  let cutoff = false;
  let pending = 0;
  let intentPending = false;
  let resolveFirstHits!: () => void;
  const firstHits = new Promise<void>((resolve) => {
    resolveFirstHits = resolve;
  });
  let textSeen = false;
  let resolveFirstText!: () => void;
  const firstText = new Promise<void>((resolve) => {
    resolveFirstText = resolve;
  });

  const settle = async (run: SourceRun): Promise<void> => {
    const raced = await Promise.race([
      run.task.then((outcome) => ({ kind: 'finished' as const, outcome })),
      run.blocked.then(() => ({ kind: 'blocked' as const })),
    ]);
    if (raced.kind === 'blocked' || run.wasBlocked()) {
      settled.add(run.id);
      pending -= 1;
      recordStat({ source: run.id, count: 0, ms: Date.now() - run.started, status: 'blocked', blockedReason: run.blockedReason() });
      deferLate(run);
      return;
    }
    if (cutoff) {
      deferLate(run);
      return;
    }
    settled.add(run.id);
    pending -= 1;
    const { outcome } = raced;
    if (outcome.kind === 'error') {
      recordStat({ source: run.id, count: 0, ms: outcome.ms, error: outcome.error });
      emit({ type: 'source_error', source: run.id, error: outcome.error, ms: outcome.ms });
      return;
    }
    recordStat({ source: run.id, count: outcome.hits.length, ms: outcome.ms });
    emit({ type: 'source_done', source: run.id, count: outcome.hits.length, ms: outcome.ms });
    if (!outcome.hits.length) return;
    hitsBySource.set(run.id, outcome.hits);
    resolveFirstHits();
    if (outcome.hits.some((hit) => hit.snippet || hit.content)) {
      textSeen = true;
      resolveFirstText();
    }
    if (pending > 0 || intentPending) emit({ type: 'fused', results: fuse(collected(), weights), partial: true });
  };

  const runs: SourceRun[] = [];
  const settles: Promise<void>[] = [];
  const launch = (id: SourceId) => {
    if (active.includes(id) || cutoff) return;
    active.push(id);
    weights[id] = config.sources[id]?.weight ?? 1;
    pending += 1;
    const run = startSource(id);
    runs.push(run);
    settles.push(settle(run));
  };
  for (const id of baseSources) launch(id);

  // A general search also asks the decision model what else is worth searching. Whatever it switches on starts now,
  // mid-search, and joins the same fusion. No verdict (no key, error, too slow) just leaves the general sources.
  const routing = mode === 'web' && !opts.sources && config.intent.enabled && judgeEnabled(config.judge);
  intentPending = routing;
  const intentDone: Promise<void> = routing
    ? (async () => {
        try {
          const verdict = await judgeIntent(query, config, env, signal);
          emit({ type: 'routed', routes: verdict.routes, scores: verdict.scores, suggest: verdict.suggest, error: verdict.error });
          for (const id of sourcesForRoutes(config, !!env.runBrowserEngine, verdict.routes)) launch(id);
        } catch {
          // Aborted: the checks after the wait deal with it.
        } finally {
          intentPending = false;
        }
      })()
    : Promise.resolve();
  const settledAll = (async () => {
    await intentDone;
    await Promise.all(settles);
  })();
  // The overview is written from what has arrived when the soft deadline passes; a source that reports later never starts one.
  const summaryWanted =
    modeHasText(mode) && (opts.summarize ?? config.summary.enabled) && (config.summary.provider === 'chrome-builtin' || llmUsable(config.llm));
  if (opts.softDeadlineMs) {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      settledAll,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, opts.softDeadlineMs);
      }),
    ]);
    clearTimeout(deadline);
    // Past the deadline with nothing to show: keep waiting for the first source that has results.
    if (!hitsBySource.size) await Promise.race([settledAll, firstHits]);
    // If the quick sources brought nothing it can use (DuckDuckGo's results carry no text), wait for one that has, or the overview is lost for good.
    if (summaryWanted && !textSeen) await Promise.race([settledAll, firstText]);
  } else {
    await settledAll;
  }
  cutoff = true;
  for (const run of runs) {
    if (!settled.has(run.id)) recordStat({ source: run.id, count: 0, ms: Date.now() - run.started, status: 'late' });
  }
  signal?.throwIfAborted();

  let results: FusedResult[] = applyDomainRules(fuse(collected(), weights), config.judge);
  emit({ type: 'fused', results });

  const textual = modeHasText(mode);
  const judging = textual && judgeEnabled(config.judge) && results.length > 0;
  const provider = config.rerank.provider;
  const canRerank =
    textual &&
    !judging &&
    provider !== 'none' &&
    results.length > 1 &&
    (provider === 'llm' ? llmUsable(config.llm) : !!config.rerank.apiKey);
  if (judging) {
    const candidates = results.filter((r) => !r.hidden).slice(0, config.judge.candidates);
    try {
      const outcome = await judgeResults(query, candidates, config, env, signal);
      if (outcome.judgments.size) results = applyJudgments(results, outcome.judgments, config.judge);
      emit({ type: 'judged', results, error: outcome.error });
    } catch (e) {
      if (signal?.aborted) throw e;
      emit({ type: 'judged', results, error: errorMessage(e) });
    }
  } else if (canRerank) {
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

  const visible = results.filter((r) => !r.hidden);
  const limited = opts.limit ? [...visible.slice(0, opts.limit), ...results.filter((r) => r.hidden)] : results;
  const result: PipelineResult = { query, mode, results: limited, citations: [], sourceStats };

  /** Page text is untrusted: withhold pages that look like they instruct the summarizing model. */
  const readPages = async (top: FusedResult[]) => {
    const contents = await fetchContents(top, config, env, signal);
    if (judgeEnabled(config.judge) && contents.size) {
      for (const key of await flagInjectedContents(query, contents, config, env, signal)) contents.delete(key);
    }
    signal?.throwIfAborted();
    return contents;
  };

  const wantSummary = textual && (opts.summarize ?? config.summary.enabled);
  // A source with no text of its own (a Xiaohongshu note has only a title and photos) has nothing to cite.
  const top = visible.filter((r) => r.snippet || r.content).slice(0, config.summary.maxSources);
  if (wantSummary && top.length && config.summary.provider === 'chrome-builtin') {
    const citations = buildCitations(top);
    result.citations = citations;
    const contents = await readPages(top);
    const messages = buildSummaryMessages(query, top, contents, config.summary.instructions, new Date(), mode);
    emit({ type: 'summary_prompt', citations, messages });
  } else if (wantSummary && top.length && llmUsable(config.llm)) {
    const citations = buildCitations(top);
    result.citations = citations;
    emit({ type: 'summary_start', citations });
    try {
      const contents = await readPages(top);
      const messages = buildSummaryMessages(query, top, contents, config.summary.instructions, new Date(), mode);
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
