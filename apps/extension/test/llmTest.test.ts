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
});
