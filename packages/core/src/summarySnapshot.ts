import { fetchContents } from './content';
import { flagInjectedContents, judgeEnabled } from './judge';
import { overviewLanguage } from './language';
import { chatStream, llmUsable } from './llm';
import { buildCitations, buildSummaryMessages } from './summarize';
import { modeHasText, type Env, type FusedResult, type FusionConfig, type NewsSearchInfo, type PipelineEvent, type SearchMode } from './types';

/** Generate from an existing result snapshot: no source search, ranking or intent request. */
export async function summarizeSnapshot(
  query: string, results: FusedResult[], config: FusionConfig, env: Env,
  options: {
    mode: SearchMode; news?: NewsSearchInfo; signal?: AbortSignal; summarySignal?: AbortSignal;
    /** A retry uses the already fetched/checked evidence, including its original timestamp. */
    reuse?: boolean; summaryAt?: string;
    onEvent?: (event: PipelineEvent) => void;
    onSnapshot?: (results: FusedResult[], summaryAt: string) => void;
  },
) {
  const limit = options.reuse ? 32 : Math.max(1, Math.min(32, config.summary.maxSources));
  const top = structuredClone(results.filter((r) => !r.hidden && (r.snippet || r.content)).slice(0, limit));
  const citations = buildCitations(top);
  const summaryAt = options.reuse && options.summaryAt ? options.summaryAt : new Date().toISOString();
  const outcome = { citations, summaryAt, results: top, summary: undefined as string | undefined };
  if (!modeHasText(options.mode) || !top.length || (config.summary.provider !== 'chrome-builtin' && !llmUsable(config.llm))) return { ...outcome, citations: [] };
  const signals = [options.signal, options.summarySignal].filter((s): s is AbortSignal => !!s);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  const emit = options.onEvent ?? (() => {});
  let checked = !!options.reuse;
  const excerptSnapshot = () => top.map(({ content: _content, ...result }) => result);
  // Establish the selected source order before any network activity.
  emit({ type: 'summary_start', citations });
  options.onSnapshot?.(checked ? top : excerptSnapshot(), summaryAt);
  try {
    signal?.throwIfAborted();
    const contents = options.reuse
      ? new Map(top.filter((r) => r.content).map((r) => [r.key, r.content!]))
      : await fetchContents(top, config, env, signal);
    if (!options.reuse && judgeEnabled(config) && contents.size) {
      for (const key of await flagInjectedContents(query, contents, config, env, signal)) contents.delete(key);
    }
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
    } else {
      let text = '';
      for await (const delta of chatStream(env.fetch, config.llm, messages, { signal })) {
        signal?.throwIfAborted();
        text += delta;
        emit({ type: 'summary_delta', text: delta });
      }
      outcome.summary = text;
      emit({ type: 'summary_done', text });
    }
  } catch (error) {
    // A cancellation or failed check must not turn unchecked source text into reusable evidence.
    if (!checked) for (const result of top) delete result.content;
    if (options.signal?.aborted) throw error;
    if (options.summarySignal?.aborted) emit({ type: 'summary_stopped' });
    else emit({ type: 'summary_error', error: error instanceof Error ? error.message : String(error) });
  }
  return outcome;
}
