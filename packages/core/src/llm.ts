import { HttpError } from './http';
import type { FetchLike, LlmSettings } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function endpoint(settings: LlmSettings): string {
  return settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

export function llmConfigured(settings: LlmSettings | undefined): boolean {
  return !!settings?.baseUrl && !!settings.model;
}

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** Callable as configured: needs a key unless it points at a local server such as Ollama. */
export function llmUsable(settings: LlmSettings | undefined): boolean {
  if (!settings || !llmConfigured(settings)) return false;
  if (settings.apiKey) return true;
  try {
    return LOCAL_HOST.test(new URL(settings.baseUrl).hostname);
  } catch {
    return false;
  }
}

export async function chat(
  fetch: FetchLike,
  settings: LlmSettings,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; temperature?: number; json?: boolean } = {},
): Promise<string> {
  const res = await fetch(endpoint(settings), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature: opts.temperature ?? 0,
      stream: false,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new HttpError(res.status, `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? '';
}

/** Streams an OpenAI-compatible chat completion, yielding content deltas. */
export async function* chatStream(
  fetch: FetchLike,
  settings: LlmSettings,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; temperature?: number } = {},
): AsyncGenerator<string> {
  const res = await fetch(endpoint(settings), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: settings.model, messages, temperature: opts.temperature ?? 0.3, stream: true }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new HttpError(res.status, `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const parseLine = (line: string): { done?: boolean; delta?: string } => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return {};
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return { done: true };
    try {
      const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
      return { delta: json.choices?.[0]?.delta?.content };
    } catch {
      return {};
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      buf += decoder.decode();
      break;
    }
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const event = parseLine(line);
      if (event.done) return;
      if (event.delta) yield event.delta;
    }
  }
  const finalEvent = parseLine(buf);
  if (finalEvent.delta) yield finalEvent.delta;
}

/** Extract the first JSON object/array from an LLM reply (tolerates code fences). */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  for (let end = body.length; end > start; end--) {
    const ch = body[end - 1];
    if (ch !== '}' && ch !== ']') continue;
    try {
      return JSON.parse(body.slice(start, end)) as T;
    } catch {
      /* shrink */
    }
  }
  return null;
}
