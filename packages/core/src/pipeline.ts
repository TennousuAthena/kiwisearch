import { DEFAULT_CONFIG, resultCount, sourcesForRoutes, usableSources } from './config';
import { applyAcademicLanguage } from './academicLanguage';
import { citesHidden, judgeSufficiency, type SufficiencyVerdict } from './earlyOverview';
import { landmarksOf, planAcademicQuery, planSourceIds, searchWithPlan, verifyPapers } from './academic';
import { loadBlocklist, type Blocklist } from './blocklist';
import { applyRerank, fuse, mergeLateHits } from './fusion';
import { errorMessage, withTimeout } from './http';
import { judgeIntent } from './intent';
import { applyNewsOptions, normalizeNewsOptions } from './news';
import { applyDomainRules, applyJudgments, judgeEnabled, judgeResults, MIN_VISIBLE } from './judge';
import { hideUnresolvedLinks } from './links';
import { llmUsable } from './llm';
import { rerank } from './rerank';
import { SOURCES } from './sources';
import { checkedContents, selectEvidence, summarizeSnapshot, type SummaryOutcomeStatus } from './summarySnapshot';
import { modeHasText } from './types';
import { foldWikipediaEditions, wikipediaFoldEnabled, wikipediaTarget } from './wikipedia';
import type { AcademicPlan, BlockReason, Citation, Env, FusedResult, FusionConfig, NewsSearchInfo, PipelineEvent, PipelineResult, RunOptions, SearchHit, SourceId, VerifiedLandmark } from './types';

/** How long a browser source may sit behind other requests for its engine before it counts as stuck. */
const QUEUE_WAIT_MS = 60_000;
const BLOCKED_TIMEOUT_MS = 120_000;

type SourceOutcome =
  | { kind: 'done'; hits: SearchHit[]; ms: number }
  | { kind: 'error'; error: string; ms: number };

interface EarlyOverview {
  status: SummaryOutcomeStatus;
  citations: Citation[];
  /** The cited results, in citation order. */
  results: FusedResult[];
  /** Unset when the browser's built-in model writes it in the page. */
  summary?: string;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (ms <= 0 || signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() {
    clearTimeout(timer);
    signal?.removeEventListener('abort', done);
    resolve();
  }
  signal?.addEventListener('abort', done, { once: true });
});

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
  const requestedAt = new Date();
  const news = mode === 'news' ? normalizeNewsOptions(opts.news) : undefined;
  // Returned with the result; an overview records `summaryAt` on it when it chooses its citations.
  const newsInfo: NewsSearchInfo | undefined = news ? { ...news, requestedAt: requestedAt.toISOString() } : undefined;
  // Different shops/variants remain separate offers even when their titles and descriptions match.
  const fusionOptions = news || mode === 'shopping' ? { urlOnly: true } : undefined;
  // Only an academic search can be limited to a language; a source routed in from a general search runs without the limit.
  const paperLanguage = mode === 'academic' && opts.language === 'en' ? opts.language : undefined;
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

  // The block lists are read while the sources start, and every list of results is filtered with the same snapshot of them.
  let lists: Blocklist | undefined;
  const listsReady = loadBlocklist(config, env).then((loaded) => {
    lists = loaded;
  });

  const sourceStats: PipelineResult['sourceStats'] = [];
  const recordStat = (stat: PipelineResult['sourceStats'][number]) => {
    const index = sourceStats.findIndex((existing) => existing.source === stat.source);
    if (index >= 0) sourceStats[index] = stat;
    else sourceStats.push(stat);
  };
  // Sources that are running or done. It grows when the decision model switches more on mid-search.
  const active: SourceId[] = [];
  const weights: Partial<Record<SourceId, number>> = {};
  // The deterministic pass every list of results goes through: Wikipedia copies in other languages folded away, then domain rules and block lists.
  const wikipedia = wikipediaFoldEnabled(config.judge.foldWikipediaEditions, env.browserLanguage) ? wikipediaTarget(env.browserLanguage) : undefined;
  const orderNews = (list: FusedResult[]): FusedResult[] => news ? applyNewsOptions(list, news, requestedAt) : list;
  // The links Google would not unwrap are hidden last, so that the other hiding has been counted first (see `links.ts`).
  const tidy = (list: FusedResult[]): FusedResult[] => hideUnresolvedLinks(orderNews(
    applyDomainRules(fusionOptions?.urlOnly ? list : foldWikipediaEditions(applyAcademicLanguage(list, paperLanguage), wikipedia, weights), config.judge, lists),
  ), MIN_VISIBLE);
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
    // A source in its academic mode is asked for the language limit, so what it returned under one limit is not reused under another.
    const sourceLanguage = sourceMode === 'academic' ? paperLanguage : undefined;
    const sourceNews = sourceMode === 'news' ? news : undefined;
    const cacheKey = `${sourceMode}${sourceLanguage ? `:${sourceLanguage}` : ''}${sourceNews ? `:${sourceNews.range}:${sourceNews.sort}` : ''}|${id}|${count}|${query.toLowerCase()}`;
    const cached = opts.refresh ? undefined : env.cache?.get(cacheKey);
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
    // A slow-rendering engine may need a baseline above the general source timeout.
    const sourceTimeoutMs = Math.max(config.sourceTimeoutMs, source.minTimeoutMs ?? 0);
    // Browser sources queue per engine; their timeout runs from `onStart`, not from enqueueing.
    let working = !source.requiresBrowser;
    if (working) arm(sourceTimeoutMs, `timeout after ${sourceTimeoutMs}ms`);
    else arm(QUEUE_WAIT_MS, `still queued after ${QUEUE_WAIT_MS}ms`);
    const onStart = () => {
      if (working || blocked) return;
      working = true;
      arm(sourceTimeoutMs, `timeout after ${sourceTimeoutMs}ms`);
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
          news: sourceNews,
          language: sourceLanguage,
          count,
          signal: controller.signal,
          onBlocked,
          onStart,
          renderer: config.renderer,
        });
        if (hits.length) env.cache?.set(cacheKey, hits, sourceNews ? 60_000 : undefined);
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
    await listsReady;
    let merged = tidy(mergeLateHits(currentResults, outcome.hits, weights, undefined, fusionOptions));
    if (modeHasText(mode) && judgeEnabled(config)) {
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
    currentResults = orderNews(merged);
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
  // From the academic plan: the papers the model named that were found to exist (first, so their rank counts even when a source also returned them), and the second-round lists (its own search text, the most-cited pass).
  let foundPapers: SearchHit[] = [];
  const extraLists: SearchHit[][] = [];
  const collected = () => [...(foundPapers.length ? [foundPapers] : []), ...active.map((id) => hitsBySource.get(id) ?? []), ...extraLists];
  let cutoff = false;
  let pending = 0;
  let intentPending = false;
  let planPending = false;
  let resolveFirstHits!: () => void;
  const firstHits = new Promise<void>((resolve) => {
    resolveFirstHits = resolve;
  });
  let textSeen = false;
  let resolveFirstText!: () => void;
  const firstText = new Promise<void>((resolve) => {
    resolveFirstText = resolve;
  });

  const summaryWanted =
    modeHasText(mode) && (opts.summarize ?? config.summary.enabled) && (config.summary.provider === 'chrome-builtin' || llmUsable(config.llm));
  const summaryEvents = {
    signal, summarySignal: opts.summarySignal, onEvent: emit,
    onSnapshot: (snapshot: FusedResult[], summaryAt: string) => {
      if (newsInfo) newsInfo.summaryAt = summaryAt;
      opts.onSummarySnapshot?.(snapshot, summaryAt);
    },
  };
  // The early overview: written from the excerpts of the first sources with text while the others still run, then kept if the
  // decision model finds it sufficient (`earlyOverview.ts`). Only where the caller has a soft deadline (the search page), so an
  // MCP caller still gets one overview from everything. A cutoff that comes first leaves the single final overview.
  const early = config.summary.early;
  const earlyWanted = summaryWanted && !!opts.softDeadlineMs && early.enabled;
  let textSources = 0;
  let earlyRun: Promise<EarlyOverview | undefined> | undefined;
  let earlyVerdict: Promise<SufficiencyVerdict> = Promise.resolve({ keep: false, reason: 'unfinished' });
  // Stops the decision model's check (and the wait before it) once the early overview is known to be replaced anyway.
  const checkStop = new AbortController();
  const checkSignal = signal ? AbortSignal.any([signal, checkStop.signal]) : checkStop.signal;
  const startEarly = () => {
    if (!earlyWanted || earlyRun || cutoff || signal?.aborted) return;
    earlyRun = (async () => {
      await listsReady;
      if (cutoff || signal?.aborted) return undefined;
      const visible = tidy(fuse(collected(), weights, undefined, fusionOptions)).filter((r) => !r.hidden);
      const outcome = await summarizeSnapshot(query, visible, config, env, {
        mode, news: newsInfo, excerptsOnly: true, phase: 'preliminary', ...(early.thinking === 'off' ? { thinking: 'off' as const } : {}), ...summaryEvents,
      });
      return outcome.status === 'skipped' ? undefined : outcome;
    })().catch(() => undefined);
    earlyVerdict = earlyRun.then(async (outcome): Promise<SufficiencyVerdict> => {
      if (!outcome || (outcome.status !== 'done' && outcome.status !== 'prompted')) return { keep: false, reason: 'unfinished' };
      await pause(early.decideMs - (Date.now() - requestedAt.getTime()), checkSignal);
      return judgeSufficiency(query, outcome.summary, outcome.results, config, env, checkSignal);
    }).catch(() => ({ keep: false, reason: 'error' }));
  };
  const earlyTimer = earlyWanted
    ? setTimeout(() => {
        if (textSeen) startEarly();
        else void firstText.then(startEarly);
      }, early.waitMs)
    : undefined;

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
    const hasText = news
      ? orderNews(fuse([outcome.hits], weights, undefined, fusionOptions)).some((hit) => !hit.hidden && (hit.snippet || hit.content))
      : outcome.hits.some((hit) => hit.snippet || hit.content);
    if (hasText) {
      textSeen = true;
      resolveFirstText();
      textSources += 1;
      if (textSources >= early.minSources) startEarly();
    }
    if (pending > 0 || intentPending || planPending) {
      await listsReady;
      emit({ type: 'fused', results: tidy(fuse(collected(), weights, undefined, fusionOptions)), partial: true });
    }
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
  const routing = mode === 'web' && !opts.sources && config.intent.enabled && judgeEnabled(config);
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
  // An academic search also asks the user's own model to read the query: what do they want, how should each database be asked,
  // which papers are they after. Those papers are looked up in a bibliographic index and kept only if found. No usable model,
  // an error or too slow just leaves the plain search.
  let academicPlan: AcademicPlan | undefined;
  let landmarks: VerifiedLandmark[] = [];
  const planning = mode === 'academic' && !opts.sources && config.academic.smart && llmUsable(config.llm);
  planPending = planning;
  const planDone: Promise<void> = planning
    ? (async () => {
        const deadline = withTimeout(signal, config.academic.timeoutMs);
        try {
          const { parsed, error } = await planAcademicQuery(query, config, env, deadline.signal, paperLanguage);
          if (!parsed) {
            emit({ type: 'academic_plan', landmarks: [], error });
            return;
          }
          const ids = planSourceIds(config).filter((id) => active.includes(id));
          const [found, second] = await Promise.all([
            verifyPapers(parsed.papers, config, env, deadline.signal, paperLanguage),
            searchWithPlan(query, parsed.plan, ids, config, env, resultCount(config, mode), deadline.signal, paperLanguage),
          ]);
          academicPlan = { ...parsed.plan, queries: second.used };
          landmarks = landmarksOf(found);
          foundPapers = found;
          extraLists.push(...second.lists);
          emit({ type: 'academic_plan', plan: academicPlan, landmarks });
        } catch (e) {
          if (!signal?.aborted) emit({ type: 'academic_plan', landmarks: [], error: errorMessage(deadline.signal.aborted ? deadline.signal.reason : e) });
        } finally {
          deadline.cancel();
          planPending = false;
        }
      })()
    : Promise.resolve();
  const settledAll = (async () => {
    await Promise.all([intentDone, planDone]);
    await Promise.all(settles);
  })();
  // The final overview is written from what has arrived when the soft deadline passes; a source that reports later never starts one.
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
    // The plan has its own limit (`academic.timeoutMs`); its papers belong in the first full list, not in a late one.
    if (planPending) await planDone;
    // A slow decision model may still be answering; what it switches on starts now and, being late, merges in afterwards.
    if (intentPending) await intentDone;
    // If the quick sources brought nothing it can use (DuckDuckGo's results carry no text), wait for one that has, or the overview is lost for good.
    if (summaryWanted && !textSeen) await Promise.race([settledAll, firstText]);
  } else {
    await settledAll;
  }
  cutoff = true;
  clearTimeout(earlyTimer);
  for (const run of runs) {
    if (!settled.has(run.id)) recordStat({ source: run.id, count: 0, ms: Date.now() - run.started, status: 'late' });
  }
  signal?.throwIfAborted();

  await listsReady;
  signal?.throwIfAborted();
  let results: FusedResult[] = tidy(fuse(collected(), weights, undefined, fusionOptions));
  emit({ type: 'fused', results });

  const textual = modeHasText(mode);
  const judging = textual && judgeEnabled(config) && results.length > 0;
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
      if (outcome.judgments.size) results = orderNews(applyJudgments(results, outcome.judgments, config.judge));
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
      results = orderNews(results);
      emit({ type: 'reranked', results, provider });
    } catch (e) {
      if (signal?.aborted) throw e;
      emit({ type: 'reranked', results, provider, error: errorMessage(e) });
    }
  }

  const visible = results.filter((r) => !r.hidden);
  const limited = opts.limit ? [...visible.slice(0, opts.limit), ...results.filter((r) => r.hidden)] : results;
  const result: PipelineResult = { query, mode, results: limited, citations: [], sourceStats, ...(newsInfo ? { news: newsInfo } : {}), ...(academicPlan ? { plan: academicPlan, landmarks } : {}) };

  const wantSummary = textual && (opts.summarize ?? config.summary.enabled);
  // With an early overview in flight, the final overview's pages are read now, beside it and the decision model's check, instead of
  // after them. If the early overview then stands, the reads are stopped.
  const prefetchStop = new AbortController();
  let prepared: Promise<Map<string, string>> | undefined;
  if (wantSummary && earlyRun && !opts.summarySignal?.aborted) {
    prepared = checkedContents(query, selectEvidence(visible, config), config, env, signal ? AbortSignal.any([signal, prefetchStop.signal]) : prefetchStop.signal);
    prepared.catch(() => {});
  }
  if (wantSummary) {
    // An early overview stands when the decision model kept it and judging hid none of what it cites; otherwise the final one replaces it.
    const preliminary = earlyRun ? await earlyRun : undefined;
    signal?.throwIfAborted();
    let verdict: SufficiencyVerdict | undefined;
    if (preliminary && !opts.summarySignal?.aborted) {
      if (citesHidden(preliminary.citations, results)) {
        // Settled already: it stands on a result judging hid, so there is nothing to wait for or to ask.
        checkStop.abort();
        verdict = { keep: false, reason: 'hidden' };
      } else {
        verdict = await earlyVerdict;
        signal?.throwIfAborted();
      }
      emit({ type: 'summary_checked', ...verdict });
    }
    if (preliminary && verdict?.keep) {
      result.citations = preliminary.citations;
      if (preliminary.summary !== undefined) result.summary = preliminary.summary;
    } else if (!preliminary || !opts.summarySignal?.aborted) {
      const summary = await summarizeSnapshot(query, visible, config, env, { mode, news: newsInfo, ...(preliminary ? { phase: 'final' as const } : {}), ...(prepared ? { prepared } : {}), ...summaryEvents });
      result.citations = summary.citations;
      if (summary.summary !== undefined) result.summary = summary.summary;
    }
  }
  prefetchStop.abort();
  checkStop.abort();

  signal?.throwIfAborted();
  currentResults = results;
  emit({ type: 'done', result });
  resolveDone();
  return result;
}
