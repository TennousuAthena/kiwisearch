import { beforeEach, describe, expect, it } from 'vitest';
import { chatStream, chatStreamHedged, forgetStreamQuirks, THINKING_OFF } from '../src/llm';
import type { LlmSettings } from '../src/types';

const settings: LlmSettings = { baseUrl: 'https://api.example/v1', apiKey: 'test', model: 'test-model' };
const encoder = new TextEncoder();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const event = (delta: Record<string, string>) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const textResponse = (text: string) => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode(event({ content: text }) + 'data: [DONE]\n\n')); c.close(); } }));
const status = (code: number) => new Response('refused', { status: code });

type Behaviour = (signal: AbortSignal | null | undefined) => Promise<Response>;
/** Answers the nth request with the nth behaviour; a behaviour that waits gives up when its request is aborted. */
function server(...behaviours: Behaviour[]) {
  const calls: { signal: AbortSignal | null | undefined; body: Record<string, unknown> }[] = [];
  const fetch = (_url: string, init?: RequestInit) => {
    calls.push({ signal: init?.signal, body: JSON.parse(String(init?.body)) });
    return behaviours[calls.length - 1](init?.signal);
  };
  return { fetch, calls };
}
const later = (ms: number, make: () => Response): Behaviour => (signal) => new Promise<Response>((resolve, reject) => {
  const timer = setTimeout(() => resolve(make()), ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
});
const now = (make: () => Response): Behaviour => later(0, make);
const collect = async (stream: AsyncGenerator<string>) => {
  let text = '';
  for await (const delta of stream) text += delta;
  return text;
};

beforeEach(() => forgetStreamQuirks());

describe('chatStreamHedged', () => {
  it('sends one request when the first one answers in time, or when hedging is off', async () => {
    const quick = server(now(() => textResponse('fast')));
    expect(await collect(chatStreamHedged(quick.fetch, settings, [], { hedgeAfterMs: 50 }))).toBe('fast');
    expect(quick.calls).toHaveLength(1);
    const off = server(later(80, () => textResponse('slow')));
    expect(await collect(chatStreamHedged(off.fetch, settings, [], { hedgeAfterMs: 0 }))).toBe('slow');
    expect(off.calls).toHaveLength(1);
  });

  it('starts a second request when the first is silent, uses the one that answers first and aborts the other', async () => {
    const { fetch, calls } = server(later(300, () => textResponse('slow')), now(() => textResponse('hedge')));
    const started = Date.now();
    expect(await collect(chatStreamHedged(fetch, settings, [], { hedgeAfterMs: 30 }))).toBe('hedge');
    expect(Date.now() - started).toBeLessThan(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it('lets the first request win when it answers after the hedge started but before the hedge does', async () => {
    const { fetch, calls } = server(later(60, () => textResponse('first')), later(200, () => textResponse('hedge')));
    expect(await collect(chatStreamHedged(fetch, settings, [], { hedgeAfterMs: 20 }))).toBe('first');
    expect(calls).toHaveLength(2);
    expect(calls[1].signal?.aborted).toBe(true);
  });

  it('does not hedge a request the server has started, even when its text is slow (a model that is thinking)', async () => {
    const thinking: Behaviour = async () => new Response(new ReadableStream({
      async start(c) {
        c.enqueue(encoder.encode(event({ reasoning_content: 'hmm' })));
        await delay(120);
        c.enqueue(encoder.encode(event({ content: 'answer' }) + 'data: [DONE]\n\n'));
        c.close();
      },
    }));
    const { fetch, calls } = server(thinking, now(() => textResponse('hedge')));
    expect(await collect(chatStreamHedged(fetch, settings, [], { hedgeAfterMs: 30 }))).toBe('answer');
    expect(calls).toHaveLength(1);
  });

  it('fails as it would without hedging when the first request fails before the hedge starts', async () => {
    const { fetch, calls } = server(now(() => status(500)), now(() => textResponse('hedge')));
    await expect(collect(chatStreamHedged(fetch, settings, [], { hedgeAfterMs: 50 }))).rejects.toThrow(/HTTP 500/);
    expect(calls).toHaveLength(1);
  });

  it('keeps going on the other request when one of two fails, and reports the first one when both do', async () => {
    const survivor = server(later(100, () => textResponse('first')), now(() => status(500)));
    expect(await collect(chatStreamHedged(survivor.fetch, settings, [], { hedgeAfterMs: 20 }))).toBe('first');
    const doomed = server(later(60, () => status(503)), now(() => status(500)));
    await expect(collect(chatStreamHedged(doomed.fetch, settings, [], { hedgeAfterMs: 20 }))).rejects.toThrow(/HTTP 503/);
    expect(doomed.calls).toHaveLength(2);
  });

  it('never hedges a model on this machine, where a slow start is the model reading the prompt', async () => {
    const { fetch, calls } = server(later(100, () => textResponse('local')), now(() => textResponse('hedge')));
    const local: LlmSettings = { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama' };
    expect(await collect(chatStreamHedged(fetch, local, [], { hedgeAfterMs: 20 }))).toBe('local');
    expect(calls).toHaveLength(1);
  });

  it('aborts every request when the caller aborts', async () => {
    const stop = new AbortController();
    const { fetch, calls } = server(later(500, () => textResponse('a')), later(500, () => textResponse('b')));
    const running = collect(chatStreamHedged(fetch, settings, [], { hedgeAfterMs: 20, signal: stop.signal }));
    await delay(60);
    expect(calls).toHaveLength(2);
    stop.abort(new Error('stopped'));
    await expect(running).rejects.toThrow();
    expect(calls.every((call) => call.signal?.aborted)).toBe(true);
  });
});

describe('chatStream asking the model not to think', () => {
  it('sends the plain request unless asked, and the strongest switch first when asked', async () => {
    const plain = server(now(() => textResponse('x')));
    await collect(chatStream(plain.fetch, settings, []));
    expect(plain.calls[0].body).not.toHaveProperty('reasoning_effort');
    expect(plain.calls[0].body).not.toHaveProperty('thinking');
    const off = server(now(() => textResponse('x')));
    await collect(chatStream(off.fetch, settings, [], { thinking: 'off' }));
    expect(off.calls[0].body).toMatchObject({ reasoning_effort: 'none', thinking: { type: 'disabled' }, stream: true });
  });

  it('steps down one form per refusal, and remembers the form that worked for the next request', async () => {
    const { fetch, calls } = server(now(() => status(400)), now(() => status(422)), now(() => textResponse('ok')), now(() => textResponse('again')));
    expect(await collect(chatStream(fetch, settings, [], { thinking: 'off' }))).toBe('ok');
    expect(calls.map((call) => Object.keys(call.body).filter((key) => key === 'reasoning_effort' || key === 'thinking'))).toEqual([
      ['reasoning_effort', 'thinking'], ['reasoning_effort'], ['thinking'],
    ]);
    expect(await collect(chatStream(fetch, settings, [], { thinking: 'off' }))).toBe('again');
    expect(calls[3].body).toMatchObject({ thinking: { type: 'disabled' } });
    expect(calls[3].body).not.toHaveProperty('reasoning_effort');
  });

  it('asks the plain way when the provider knows neither, and does not walk the ladder for other failures', async () => {
    const refusing = server(...THINKING_OFF.slice(0, -1).map(() => now(() => status(400))), now(() => textResponse('plain')));
    expect(await collect(chatStream(refusing.fetch, settings, [], { thinking: 'off' }))).toBe('plain');
    expect(refusing.calls.at(-1)?.body).not.toHaveProperty('thinking');
    forgetStreamQuirks();
    const broken = server(now(() => status(500)), now(() => textResponse('never')));
    await expect(collect(chatStream(broken.fetch, settings, [], { thinking: 'off' }))).rejects.toThrow(/HTTP 500/);
    expect(broken.calls).toHaveLength(1);
  });
});
