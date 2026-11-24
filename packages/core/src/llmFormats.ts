import type { ChatMessage } from './llm';
import type { LlmApiFormat } from './types';

type MessageOptions = { stream: boolean; temperature?: number; json?: boolean; extra?: Record<string, unknown> };

export function llmRequestBody(format: LlmApiFormat, model: string, messages: ChatMessage[], opts: MessageOptions): unknown {
  const { stream, temperature, json, extra } = opts;
  if (format === 'chat-completions') {
    return { model, messages, temperature, stream, ...(json ? { response_format: { type: 'json_object' } } : {}), ...extra };
  }
  const system = messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n\n');
  const turns = messages.filter(({ role }) => role !== 'system');
  if (format === 'responses') {
    return { model, input: turns, ...(system ? { instructions: system } : {}), stream, ...(json ? { text: { format: { type: 'json_object' } } } : {}) };
  }
  if (format === 'anthropic') {
    return { model, messages: turns, ...(system ? { system } : {}), max_tokens: 4096, stream };
  }
  return {
    contents: turns.map(({ role, content }) => ({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text: content }] })),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
  };
}

type TextPart = { type?: string; text?: string; thought?: boolean };
type ModelPayload = {
  choices?: { message?: { content?: string }; delta?: { content?: string } }[];
  type?: string;
  delta?: string | TextPart;
  output?: { type?: string; content?: TextPart[] }[];
  content?: TextPart[];
  candidates?: { content?: { parts?: TextPart[] } }[];
  error?: { message?: string };
  response?: { error?: { message?: string } };
};

function textParts(parts: TextPart[] | undefined, type?: string): string {
  if (!Array.isArray(parts)) return '';
  return parts.filter((part) => part && !part.thought && (!type || part.type === type) && typeof part.text === 'string')
    .map((part) => part.text).join('');
}

export function llmResponseText(format: LlmApiFormat, value: unknown, stream: boolean): string {
  const data = value as ModelPayload | null;
  if (!data) return '';
  if (data.error || data.type === 'error' || data.type === 'response.failed') {
    throw new Error(data.error?.message ?? data.response?.error?.message ?? 'LLM response failed');
  }
  switch (format) {
    case 'responses':
      if (stream) return data.type === 'response.output_text.delta' && typeof data.delta === 'string' ? data.delta : '';
      return Array.isArray(data.output) ? data.output.filter((item) => item?.type === 'message').map((item) => textParts(item.content, 'output_text')).join('') : '';
    case 'anthropic':
      if (stream) return data.type === 'content_block_delta' && typeof data.delta === 'object'
        && data.delta?.type === 'text_delta' && typeof data.delta.text === 'string' ? data.delta.text : '';
      return textParts(data.content, 'text');
    case 'gemini':
      return Array.isArray(data.candidates) ? textParts(data.candidates[0]?.content?.parts) : '';
    default: {
      const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
      const text = stream ? choice?.delta?.content : choice?.message?.content;
      return typeof text === 'string' ? text : '';
    }
  }
}
