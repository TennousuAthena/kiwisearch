import { getLocale, setLocale, t } from '@kiwi-search/app/i18n';
import type { LlmApiFormat } from '@kiwi-search/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleLlmTest } from '../lib/llmTest';

afterEach(() => vi.unstubAllGlobals());

/** The settings page's "测试连接" with a model on OpenCode's gateway, which refuses a request without a session header. */
function gateway() {
  const seen: { url: string; session: string | null }[] = [];
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const session = new Headers(init?.headers).get('x-opencode-session');
    seen.push({ url: input, session });
    if (!session) return new Response(JSON.stringify({ type: 'error', error: { type: 'MissingSessionID', message: 'Request is missing x-opencode-session' } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  return seen;
}

describe('testing the connection to a model', () => {
  it('works with a model on OpenCode Go, which needs a session id', async () => {
    const seen = gateway();
    const reply = await handleLlmTest({ llm: { baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'deepseek-v4.1-flash' } });
    expect(reply.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].session).toMatch(/^ses_[0-9a-f]{32}$/);
  });

  it('sends nothing extra to any other service', async () => {
    const seen = gateway();
    await handleLlmTest({ llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-flash' } });
    expect(seen[0].session).toBeNull();
  });

  const completions = { choices: [{ message: { content: 'ok' } }] };
  const responses = { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] };
  const connection = (apiFormat: LlmApiFormat) => ({
    llm: { baseUrl: 'https://api.example', apiKey: 'mock-key', model: 'demo', apiFormat },
  });

  it.each([
    ['chat-completions', completions, responses, { choices: [{ message: { content: ' ' } }] }],
    ['responses', responses, completions, { output: [{ type: 'message', content: [{ type: 'output_text', text: 42 }] }] }],
    ['anthropic', { content: [{ type: 'text', text: 'ok' }] }, completions, { content: 'not an array' }],
    ['gemini', { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }, completions, { candidates: [{ content: { parts: [{ text: '' }] } }] }],
  ] as const)('requires readable %s output on HTTP 200', async (format, valid, wrong, malformed) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(valid))
      .mockResolvedValueOnce(Response.json(wrong))
      .mockResolvedValueOnce(Response.json(malformed))
      .mockResolvedValueOnce(new Response('<html>not JSON</html>'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    expect(await handleLlmTest(connection(format))).toMatchObject({ ok: true });
    for (let i = 0; i < 4; i++) {
      expect(await handleLlmTest(connection(format))).toEqual({ ok: false, error: t('options.test.llmBadShape') });
    }
  });

  it.each([
    ['zh-CN', '服务器响应与所选 API 格式不匹配。请检查 API 地址和格式。'],
    ['en', 'The response does not match the selected API format. Check the API address and format.'],
  ])('localizes Claude receiving a Chat Completions reply in %s', async (locale, error) => {
    const previous = getLocale();
    try {
      setLocale(locale);
      vi.stubGlobal('fetch', async () => Response.json(completions));
      expect(await handleLlmTest(connection('anthropic'))).toEqual({ ok: false, error });
    } finally {
      setLocale(previous);
    }
  });

  it('preserves an unsuccessful HTTP response as an HTTP failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('Unauthorized', { status: 401 }));
    expect(await handleLlmTest(connection('anthropic'))).toEqual({ ok: false, error: 'LLM HTTP 401: Unauthorized' });
  });
});
