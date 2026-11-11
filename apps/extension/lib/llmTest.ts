import { chat, llmUsable, type LlmSettings } from '@kiwi-search/core';

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
