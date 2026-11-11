import type { ChatMessage } from '@kiwi-search/core';

interface PromptSession {
  promptStreaming(input: string): Promise<ReadableStream<string>>;
  destroy?(): void;
}

interface PromptApi {
  availability(): Promise<string>;
  create(): Promise<PromptSession>;
}

/** Stream a completion from Chrome's built-in model (Prompt API); only available in page contexts. */
export async function promptWithBuiltinModel(
  messages: ChatMessage[],
  onDelta: (delta: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const model = (globalThis as typeof globalThis & { LanguageModel?: PromptApi }).LanguageModel;
  if (!model) throw new Error('当前浏览器不支持内置模型');
  const availability = await model.availability();
  if (signal.aborted) return;
  if (!['available', 'downloadable', 'downloading'].includes(availability)) throw new Error('当前浏览器不支持内置模型');
  const session = await model.create();
  let reader: ReadableStreamDefaultReader<string> | undefined;
  const abort = () => {
    void reader?.cancel().catch(() => {});
    session.destroy?.();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) return;
    const prompt = messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
    const stream = await session.promptStreaming(prompt);
    if (signal.aborted) {
      void stream.cancel().catch(() => {});
      return;
    }
    reader = stream.getReader();
    let receivedContent = false;
    for (;;) {
      if (signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        receivedContent = true;
        onDelta(value);
      }
    }
    if (!receivedContent && !signal.aborted) throw new Error('浏览器内置模型没有生成内容，请稍后重试。');
  } finally {
    signal.removeEventListener('abort', abort);
    reader?.releaseLock();
    session.destroy?.();
  }
}
