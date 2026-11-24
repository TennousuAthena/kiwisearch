import { describe, expect, it, vi } from 'vitest';
import { handleLlmModels } from '../lib/llmModels';

describe('model discovery', () => {
  it.each([
    ['openai', 'https://api.openai.com/v1/models', 'Bearer mock-key'],
    ['deepseek', 'https://api.deepseek.com/models', 'Bearer mock-key'],
    ['openrouter', 'https://openrouter.ai/api/v1/models', null],
    ['ollama', 'http://localhost:11434/api/tags', null],
    ['custom', 'https://custom.example/gateway/v1/models', 'Bearer mock-key'],
  ])('fetches and normalizes %s models', async (provider, url, authorization) => {
    const request = vi.fn(async () => Response.json({
      data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, null, { id: 4 }],
      models: [{ model: 'b' }, { name: 'a' }, { model: 'b' }, null],
    }));
    expect(await handleLlmModels({
      provider,
      baseUrl: provider === 'ollama' ? 'http://localhost:11434/v1/' : 'https://custom.example/gateway/v1/',
      apiKey: 'mock-key',
    }, request)).toEqual({ ok: true, models: ['a', 'b'] });
    expect(request).toHaveBeenCalledWith(url, expect.objectContaining({
      headers: authorization ? { Authorization: authorization } : {},
      credentials: 'omit',
      redirect: 'error',
    }));
  });

  it('distinguishes an Ollama 403, a malformed response, and invalid addresses', async () => {
    expect(await handleLlmModels({ provider: 'ollama', baseUrl: 'http://localhost:11434' },
      async () => new Response(null, { status: 403 }))).toEqual({ ok: false, reason: 'ollamaOrigin' });
    expect(await handleLlmModels({ provider: 'openrouter' }, async () => Response.json({}))).toEqual({ ok: false, reason: 'response' });
    const request = vi.fn();
    expect(await handleLlmModels({ provider: 'ollama', baseUrl: 'https://external.example' }, request)).toEqual({ ok: false, reason: 'address' });
    expect(await handleLlmModels({ provider: 'openai' }, request)).toEqual({ ok: false, reason: 'key' });
    expect(request).not.toHaveBeenCalled();
  });
});
