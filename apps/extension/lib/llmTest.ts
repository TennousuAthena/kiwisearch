import { chat, llmUsable, postSystemOne, systemOneUsable, type FusionConfig, type LlmSettings, type SystemOneResponse } from '@kiwi-search/core';

export interface LlmTestReply {
  ok: boolean;
  ms?: number;
  error?: string;
}

const TIMEOUT_MS = 20_000;

/** One tiny completion against the settings the user is looking at, so a wrong key or address is caught on the settings page, not mid-search. */
export async function handleLlmTest(message: unknown): Promise<LlmTestReply> {
  const llm = (message as { llm?: LlmSettings }).llm;
  if (!llm || !llmUsable(llm)) return { ok: false, error: '还没填好：需要 Base URL 和模型，以及 API Key（本机服务除外）。' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    await chat((input, init) => fetch(input, init), llm, [{ role: 'user', content: 'Reply with one word: ok' }], { signal: controller.signal });
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: controller.signal.aborted ? `${TIMEOUT_MS / 1000} 秒内没有回应。` : error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One tiny question to the dedicated decision model the user typed in, so a wrong address, key or protocol is caught on the settings
 * page. The service must answer in System One's shape (see docs/DECISION-PROVIDERS.md).
 */
export async function handleDecisionTest(message: unknown): Promise<LlmTestReply> {
  const judge = (message as { judge?: Pick<FusionConfig['judge'], 'endpoint' | 'apiKey' | 'model'> }).judge;
  if (!judge || !systemOneUsable(judge)) return { ok: false, error: '还没填好：需要服务地址，以及 Key（本机服务除外）。' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const reply = await postSystemOne<SystemOneResponse>(
      { fetch: (input, init) => fetch(input, init) },
      judge,
      {
        model: judge.model,
        state: { query: 'test' },
        questions: {
          ping: {
            type: 'noul',
            instructions: 'Is `query` exactly the word "test"?',
            criteria: { true: 'The query is the word "test"', false: 'The query is anything else' },
          },
        },
      },
      controller.signal,
    );
    if (typeof reply?.answers?.ping?.noul !== 'number') return { ok: false, error: '服务有回应，但不是 System One 的格式：缺少 answers.ping.noul。' };
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: controller.signal.aborted ? `${TIMEOUT_MS / 1000} 秒内没有回应。` : error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
