import { fetchContents } from './content';
import { flagInjectedContents, judgeEnabled } from './judge';
import { overviewLanguage } from './language';
import { chatStreamHedged, llmUsable } from './llm';
import { buildCitations, buildSummaryMessages } from './summarize';
import { modeHasText, type Env, type FusedResult, type FusionConfig, type NewsSearchInfo, type PipelineEvent, type SearchMode, type SummaryPhase } from './types';

/** How a generation ended: `prompted` hands the text to the page's built-in model, so its outcome is not known here. */
export type SummaryOutcomeStatus = 'skipped' | 'done' | 'prompted' | 'error' | 'stopped';

/** The results an overview is written from, in citation order. */
export function selectEvidence(results: FusedResult[], config: FusionConfig, reuse = false): FusedResult[] {
  const limit = reuse ? 32 : Math.max(1, Math.min(32, config.summary.maxSources));
  return results.filter((r) => !r.hidden && (r.snippet || r.content)).slice(0, limit);
}

/** The page text for `top`, with the pages that try to instruct the model left out. Reads pages: it can run beside other work. */
export async function checkedContents(query: string, top: FusedResult[], config: FusionConfig, env: Env, signal?: AbortSignal): Promise<Map<string, string>> {
  const contents = await fetchContents(top, config, env, signal);
  if (judgeEnabled(config) && contents.size) {
    for (const key of await flagInjectedContents(query, contents, config, env, signal)) contents.delete(key);
  }
  return contents;
}

/** Generate from an existing result snapshot: no source search, ranking or intent request. */
export async function summarizeSnapshot(
  query: string, results: FusedResult[], config: FusionConfig, env: Env,
  options: {
    mode: SearchMode; news?: NewsSearchInfo; signal?: AbortSignal; summarySignal?: AbortSignal;
    /** A retry uses the already fetched/checked evidence, including its original timestamp. */
    reuse?: boolean; summaryAt?: string;
    /** Write from the search excerpts alone: no page reads, so no injection check is needed (the early overview). */
    excerptsOnly?: boolean;
    /** The page text of `selectEvidence(results)`, being read already (`checkedContents`); if it failed, the pages are read here. */
    prepared?: Promise<Map<string, string>>;
    /** Ask the model not to think first. */
    thinking?: 'off';
    /** Set on every summary event; an overview written without one is the final one. */
    phase?: SummaryPhase;
    onEvent?: (event: PipelineEvent) => void;
    onSnapshot?: (results: FusedResult[], summaryAt: string) => void;
  },
) {
  const top = structuredClone(selectEvidence(results, config, options.reuse));
  const citations = buildCitations(top);
  const summaryAt = options.reuse && options.summaryAt ? options.summaryAt : new Date().toISOString();
  const outcome = { citations, summaryAt, results: top, summary: undefined as string | undefined, status: 'skipped' as SummaryOutcomeStatus };
  if (!modeHasText(options.mode) || !top.length || (config.summary.provider !== 'chrome-builtin' && !llmUsable(config.llm))) return { ...outcome, citations: [] };
  if (options.excerptsOnly) for (const result of top) delete result.content;
  const signals = [options.signal, options.summarySignal].filter((s): s is AbortSignal => !!s);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const send = options.onEvent ?? (() => {});
  const emit = options.phase ? (event: PipelineEvent) => send({ ...event, phase: options.phase } as PipelineEvent) : send;
  let checked = !!options.reuse || !!options.excerptsOnly;
  const excerptSnapshot = () => top.map(({ content: _content, ...result }) => result);
  // Establish the selected source order before any network activity.
  emit({ type: 'summary_start', citations });
  options.onSnapshot?.(checked ? top : excerptSnapshot(), summaryAt);
  try {
    signal?.throwIfAborted();
    const contents = options.reuse
      ? new Map(top.filter((r) => r.content).map((r) => [r.key, r.content!]))
      : options.excerptsOnly ? new Map<string, string>()
      : (await options.prepared?.catch(() => undefined)) ?? await checkedContents(query, top, config, env, signal);
    signal?.throwIfAborted();
    // Store only the checked text. A rejected original `content` must not reappear on retry.
    for (const result of top) {
      delete result.content;
      if (contents.has(result.key)) result.content = contents.get(result.key);
    }
    checked = true;
    options.onSnapshot?.(top, summaryAt);
    const messages = buildSummaryMessages(query, top, contents, config.summary.instructions, new Date(summaryAt), options.mode,
      overviewLanguage(config.summary, env.browserLanguage), options.news);
    if (config.summary.provider === 'chrome-builtin') {
      emit({ type: 'summary_prompt', citations, messages });
      outcome.status = 'prompted';
    } else {
      let text = '';
      const stream = chatStreamHedged(env.fetch, config.llm, messages, { signal, hedgeAfterMs: config.summary.hedgeMs, ...(options.thinking ? { thinking: options.thinking } : {}) });
      for await (const delta of stream) {
        signal?.throwIfAborted();
        text += delta;
        emit({ type: 'summary_delta', text: delta });
      }
      outcome.summary = text;
      outcome.status = 'done';
      emit({ type: 'summary_done', text });
    }
  } catch (error) {
    // A cancellation or failed check must not turn unchecked source text into reusable evidence.
    if (!checked) for (const result of top) delete result.content;
    if (options.signal?.aborted) throw error;
    if (options.summarySignal?.aborted) {
      outcome.status = 'stopped';
      emit({ type: 'summary_stopped' });
    } else {
      outcome.status = 'error';
      emit({ type: 'summary_error', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcome;
}
