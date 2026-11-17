import { describe, expect, it } from 'vitest';
import { chat, chatStream } from '../src/llm';
import { isOpenCodeUrl, newSessionId, withGatewayHeaders } from '../src/gateway';
import type { FetchLike, LlmSettings } from '../src/types';

const GO: LlmSettings = { baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'test-key', model: 'deepseek-v4.1-flash' };

/** What the gateway answered on 2026-09-06 to a request without the header (the body is the one users reported). */
const MISSING = JSON.stringify({ type: 'error', error: { type: 'MissingSessionID', message: 'Request is missing x-opencode-session and cannot be routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it' } });

/** A stand-in for the Go lane: it refuses a request without the session header and records the ones it accepts. */
function gateway() {
  const accepted: { url: string; session: string; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers = new Headers(init?.headers);
    const session = headers.get('x-opencode-session');
    if (!session) return new Response(MISSING, { status: 400 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    accepted.push({ url: input, session, body });
    if (body.stream) {
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  };
  return { fetch, accepted };
}

describe('the model gateway that wants a session id', () => {
  it('refuses a plain request, which is what users saw: HTTP 400 MissingSessionID', async () => {
    const { fetch } = gateway();
    await expect(chat(fetch, GO, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/LLM HTTP 400.*MissingSessionID/);
  });

  it('answers once the request goes through withGatewayHeaders, for a completion and for a stream', async () => {
    const { fetch, accepted } = gateway();
    const wrapped = withGatewayHeaders(fetch);
    expect(await chat(wrapped, GO, [{ role: 'user', content: 'hi' }])).toBe('ok');
    let text = '';
    for await (const delta of chatStream(wrapped, GO, [{ role: 'user', content: 'hi' }])) text += delta;
    expect(text).toBe('ok');
    expect(accepted).toHaveLength(2);
    expect(accepted[0].session).toMatch(/^ses_[0-9a-f]{32}$/);
  });

  it('keeps one session id for everything one search asks, and makes a new one for the next search', async () => {
    const { fetch, accepted } = gateway();
    const first = withGatewayHeaders(fetch);
    const second = withGatewayHeaders(fetch);
    for (let i = 0; i < 3; i++) await chat(first, GO, [{ role: 'user', content: 'hi' }]);
    await chat(second, GO, [{ role: 'user', content: 'hi' }]);
    expect(new Set(accepted.slice(0, 3).map((request) => request.session)).size).toBe(1);
    expect(accepted[3].session).not.toBe(accepted[0].session);
  });

  it('does not make an id until a request to the gateway needs one, and not for any other host', async () => {
    let made = 0;
    const seen: (string | null)[] = [];
    const base: FetchLike = async (_input, init) => { seen.push(new Headers(init?.headers).get('x-opencode-session')); return new Response('{}'); };
    const wrapped = withGatewayHeaders(base, () => `ses_${++made}`);
    for (const url of ['https://api.deepseek.com/v1/chat/completions', 'https://api.openai.com/v1/chat/completions', 'http://localhost:11434/v1/chat/completions', 'https://opencode.ai.example.com/v1', 'https://notopencode.ai/v1']) await wrapped(url, { method: 'POST' });
    expect(made).toBe(0);
    expect(seen.every((value) => value === null)).toBe(true);
    await wrapped('https://opencode.ai/zen/v1/chat/completions');
    await wrapped('https://www.opencode.ai/inference/go/openai/v1/chat/completions');
    expect(made).toBe(1);
    expect(seen.slice(-2)).toEqual(['ses_1', 'ses_1']);
  });

  it('keeps a header the caller set, and everything else about the request', async () => {
    let received: RequestInit | undefined;
    const base: FetchLike = async (_input, init) => { received = init; return new Response('{}'); };
    const signal = new AbortController().signal;
    await withGatewayHeaders(base)('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST', body: '{"a":1}', signal, headers: { 'X-OpenCode-Session': 'mine', Authorization: 'Bearer k' } });
    const headers = new Headers(received?.headers);
    expect(headers.get('x-opencode-session')).toBe('mine');
    expect(headers.get('authorization')).toBe('Bearer k');
    expect(received).toMatchObject({ method: 'POST', body: '{"a":1}', signal });
  });

  it('recognizes the gateway by host, and treats anything that is not an address as another host', () => {
    expect(isOpenCodeUrl('https://opencode.ai/zen/go/v1/chat/completions')).toBe(true);
    expect(isOpenCodeUrl('https://OpenCode.AI/zen/v1')).toBe(true);
    expect(isOpenCodeUrl('https://api.opencode.ai/v1')).toBe(true);
    for (const other of ['https://opencode.ai.evil.example/v1', 'https://evilopencode.ai/v1', 'https://example.com/?u=opencode.ai', 'not a url', '']) expect(isOpenCodeUrl(other), other).toBe(false);
  });

  it('makes ids of the shape OpenCode\'s own tools use, and not the same one twice', () => {
    const ids = Array.from({ length: 20 }, () => newSessionId());
    for (const id of ids) expect(id).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
