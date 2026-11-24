import { HttpError } from './http';
import { isLocalUrl, resolveLlmSettings } from './llmProfiles';
import type { FetchLike, LlmSettings } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function endpoint(settings: LlmSettings): string {
  return settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
}

export function llmConfigured(settings: LlmSettings | undefined): boolean {
  if (settings) settings = resolveLlmSettings(settings);
  return !!settings?.baseUrl && !!settings.model;
}

/** Callable as configured: needs a key unless it points at a local server such as Ollama. */
export function llmUsable(settings: LlmSettings | undefined): boolean {
  if (settings) settings = resolveLlmSettings(settings);
  if (!settings || !llmConfigured(settings)) return false;
  return !!settings.apiKey || isLocalUrl(settings.baseUrl);
}

export async function chat(
  fetch: FetchLike,
  settings: LlmSettings,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; temperature?: number; json?: boolean } = {},
): Promise<string> {
  settings = resolveLlmSettings(settings);
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

/**
 * Ways to ask a chat model not to think before it answers, strongest first. Providers differ: some gateways take
 * `reasoning_effort: 'none'` (and ignore `thinking`), DeepSeek's own API takes `thinking: {type: 'disabled'}`, and one that knows
 * neither either ignores the fields or answers 400/422, which moves the request one step down.
 */
export const THINKING_OFF: Record<string, unknown>[] = [
  { reasoning_effort: 'none', thinking: { type: 'disabled' } },
  { reasoning_effort: 'none' },
  { thinking: { type: 'disabled' } },
  {},
];

/** Which step of `THINKING_OFF` an endpoint and model accepted, for as long as the worker lives. */
const streamQuirks = new Map<string, number>();

/** Forget what the endpoints taught us. Only tests need it. */
export function forgetStreamQuirks(): void {
  streamQuirks.clear();
}

export interface StreamOptions {
  signal?: AbortSignal;
  temperature?: number;
  /** Ask the model not to think first (see `THINKING_OFF`). */
  thinking?: 'off';
  /** Called for every event the server sends, text or not: the request is under way (see `chatStreamHedged`). */
  onActivity?: () => void;
}

/** Streams an OpenAI-compatible chat completion, yielding content deltas. */
export async function* chatStream(
  fetch: FetchLike,
  settings: LlmSettings,
  messages: ChatMessage[],
  opts: StreamOptions = {},
): AsyncGenerator<string> {
  settings = resolveLlmSettings(settings);
  const ladder = opts.thinking === 'off' ? THINKING_OFF : [{}];
  const last = ladder.length - 1;
  const quirkKey = `${settings.baseUrl}\n${settings.model}`;
  let rung = opts.thinking === 'off' ? Math.min(streamQuirks.get(quirkKey) ?? 0, last) : 0;
  let res: Response;
  for (;;) {
    res = await fetch(endpoint(settings), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: settings.model, messages, temperature: opts.temperature ?? 0.3, stream: true, ...ladder[rung] }),
      signal: opts.signal,
    });
    if (res.ok && res.body) break;
    // A refusal of the thinking switch moves one step down; any other failure is the caller's.
    if (![400, 422].includes(res.status) || rung >= last || opts.signal?.aborted) throw new HttpError(res.status, `LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await res.body?.cancel().catch(() => {});
    rung++;
  }
  if (opts.thinking === 'off') streamQuirks.set(quirkKey, rung);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const parseLine = (line: string): { done?: boolean; delta?: string; active?: boolean } => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return {};
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') return { done: true };
    try {
      const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
      return { delta: json.choices?.[0]?.delta?.content, active: true };
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
      if (event.active) opts.onActivity?.();
      if (event.done) return;
      if (event.delta) yield event.delta;
    }
  }
  const finalEvent = parseLine(buf);
  if (finalEvent.active) opts.onActivity?.();
  if (finalEvent.delta) yield finalEvent.delta;
}

/**
 * `chatStream`, with a second identical request when the first has sent nothing at all `hedgeAfterMs` after it started: a slow
 * answer from a shared gateway is usually that one request waiting, not the model working (measured on the overview model: the
 * same tiny prompt took 1.2 to 33 s to its first byte), so the next request often beats it. Whichever sends an event first
 * (reasoning counts, so a model that is thinking is not hedged) is used from then on and the other is aborted; their text is
 * never mixed. A request that fails before the hedge starts fails the call, as without hedging; once both are in flight, one
 * failing leaves the other. Never for a server on this machine, where a slow start is the model reading the prompt and a second
 * copy would only queue behind it. `hedgeAfterMs` 0 is plain `chatStream`.
 */
export async function* chatStreamHedged(
  fetch: FetchLike,
  settings: LlmSettings,
  messages: ChatMessage[],
  opts: StreamOptions & { hedgeAfterMs?: number } = {},
): AsyncGenerator<string> {
  settings = resolveLlmSettings(settings);
  const { hedgeAfterMs, ...streamOpts } = opts;
  if (!hedgeAfterMs || hedgeAfterMs <= 0 || isLocalUrl(settings.baseUrl)) {
    yield* chatStream(fetch, settings, messages, streamOpts);
    return;
  }
  interface Attempt {
    abort: AbortController;
    iter: AsyncGenerator<string>;
    /** The first read: settles with the first text, the end of the stream, or its failure. */
    first: Promise<IteratorResult<string>>;
    /** Resolves when the server sends its first event. */
    started: Promise<void>;
  }
  const attempts: Attempt[] = [];
  const launch = (): Attempt => {
    const abort = new AbortController();
    const signal = streamOpts.signal ? AbortSignal.any([streamOpts.signal, abort.signal]) : abort.signal;
    let mark!: () => void;
    const started = new Promise<void>((resolve) => {
      mark = resolve;
    });
    const iter = chatStream(fetch, settings, messages, { ...streamOpts, signal, onActivity: mark });
    const first = iter.next();
    first.catch(() => {}); // a loser's failure is nobody's to handle
    const attempt = { abort, iter, first, started };
    attempts.push(attempt);
    return attempt;
  };
  /** `ok` once the request is under way (an event, or a first read that did not fail), `failed` if it failed before. */
  const outcome = (a: Attempt) => Promise.race([a.started.then(() => 'ok' as const), a.first.then(() => 'ok' as const, () => 'failed' as const)]);
  try {
    const primary = launch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), hedgeAfterMs);
    });
    const early = await Promise.race([outcome(primary), waited]);
    clearTimeout(timer);
    let winner = primary;
    if (early === 'late') {
      const hedge = launch();
      winner = await new Promise<Attempt>((resolve) => {
        let failed = 0;
        for (const a of [primary, hedge]) {
          void outcome(a).then((o) => {
            if (o === 'ok') resolve(a);
            // Both failed: the first request's error is the one to report.
            else if (++failed === 2) resolve(primary);
          });
        }
      });
      for (const a of attempts) if (a !== winner) a.abort.abort();
    }
    let step = await winner.first;
    while (!step.done) {
      yield step.value;
      step = await winner.iter.next();
    }
  } finally {
    for (const a of attempts) a.abort.abort();
  }
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
