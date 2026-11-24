import { editLlmEndpoint, llmBaseUrl, llmEndpoint, resolveLlmSettings, type LlmSettings } from '@kiwi-search/core';
import { describe, expect, it, vi } from 'vitest';
import { alignLlmModelLookup, handleLlmModels, llmModelRequest } from '../lib/llmModels';

function customSettings(baseUrl: string, apiFormat: 'chat-completions' | 'gemini'): LlmSettings {
  return {
    baseUrl: '', model: 'demo', apiKey: '',
    selection: { provider: 'custom', model: 'demo' },
    profiles: { custom: { baseUrl, apiFormat } },
  };
}

describe('model discovery', () => {
  it('uses the OpenRouter chat and model paths after editing a Gemini address', async () => {
    const saved = customSettings('https://generativelanguage.googleapis.com/v1beta', 'gemini');
    const connection = resolveLlmSettings({ ...saved, ...editLlmEndpoint(saved, 'https://openrouter.ai/api/') });
    const message = llmModelRequest('custom', connection);
    expect(llmEndpoint(message.baseUrl, message.apiFormat, connection.model, false)).toBe('https://openrouter.ai/api/v1/chat/completions');
    const request = vi.fn(async () => Response.json({ data: [{ id: 'demo' }] }));
    expect(await handleLlmModels(message, request)).toEqual({ ok: true, models: ['demo'] });
    expect(request).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', expect.anything());
  });

  it('keeps the first pending lookup active when address blur trims its trailing slash', async () => {
    const typed = 'http://127.0.0.1:18911/repro/v1/';
    const message = llmModelRequest('custom', resolveLlmSettings(customSettings(typed, 'chat-completions')));
    const pending = { signature: JSON.stringify(message) };
    const request = vi.fn(async () => Response.json({ data: [{ id: 'demo' }] }));
    const replyPromise = handleLlmModels(message, request);
    const afterBlur = llmModelRequest('custom', resolveLlmSettings(customSettings(llmBaseUrl(typed), 'chat-completions')));
    expect(alignLlmModelLookup(pending, JSON.stringify(afterBlur))).toBe(pending);
    expect(await replyPromise).toEqual({ ok: true, models: ['demo'] });
    expect(request).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:18911/repro/v1/models', expect.anything());
  });

  it('surfaces a retry after a real connection change invalidates a pending lookup', () => {
    const pending = { signature: 'before' };
    const changed = alignLlmModelLookup(pending, 'after');
    expect(changed).toEqual({ signature: 'after', reply: { ok: false, reason: 'settingsChanged' } });
    expect(alignLlmModelLookup(changed, 'before')).toEqual({ ...changed, signature: 'before' });
  });

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

  it.each([
    ['responses', 'https://openai.example/v1/responses', 'https://openai.example/v1/models', { Authorization: 'Bearer mock-key' }, { data: [{ id: 'demo' }] }],
    ['anthropic', 'https://api.anthropic.com', 'https://api.anthropic.com/v1/models', { 'x-api-key': 'mock-key', 'anthropic-version': '2023-06-01' }, { data: [{ id: 'demo' }] }],
    ['gemini', 'https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta/models', { 'x-goog-api-key': 'mock-key' }, {
      models: [
        { name: 'models/demo', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embeddings', supportedGenerationMethods: ['embedContent'] },
      ],
    }],
  ])('lists models for custom %s endpoints', async (apiFormat, baseUrl, url, headers, payload) => {
    const request = vi.fn(async () => Response.json(payload));
    expect(await handleLlmModels({ provider: 'custom', baseUrl, apiFormat, apiKey: 'mock-key' }, request))
      .toEqual({ ok: true, models: ['demo'] });
    expect(request).toHaveBeenCalledWith(url, expect.objectContaining({ headers, redirect: 'error' }));
  });

  it.each([
    ['custom', 'chat-completions', 'https://custom.example/gateway', 'https://custom.example/gateway/models', { data: [{ id: 'demo' }] }],
    ['custom', 'chat-completions', 'https://openrouter.ai/api', 'https://openrouter.ai/api/v1/models', { data: [{ id: 'demo' }] }],
    ['custom', 'chat-completions', 'https://custom.example/chat/completions', 'https://custom.example/models', { data: [{ id: 'demo' }] }],
    ['custom', 'gemini', 'https://custom.example/v1/models/old:generateContent', 'https://custom.example/v1/models', { models: [{ name: 'models/demo' }] }],
    ['custom', 'gemini', 'https://custom.example/v1', 'https://custom.example/v1beta/models', { models: [{ name: 'models/demo' }] }],
    ['custom', 'chat-completions', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      'https://generativelanguage.googleapis.com/v1beta/openai/models', { data: [{ id: 'demo' }] }],
    ['ollama', 'chat-completions', 'http://localhost:11434/proxy/v1/chat/completions',
      'http://localhost:11434/proxy/api/tags', { models: [{ model: 'demo' }] }],
    ['ollama', 'chat-completions', 'http://localhost:11434/gateway/v2',
      'http://localhost:11434/gateway/v2/api/tags', { models: [{ model: 'demo' }] }],
  ])('normalizes %s %s discovery address %s', async (provider, apiFormat, baseUrl, url, payload) => {
    const request = vi.fn(async () => Response.json(payload));
    expect(await handleLlmModels({ provider, apiFormat, baseUrl, apiKey: 'mock-key' }, request)).toEqual({ ok: true, models: ['demo'] });
    expect(request).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }));
  });

  it.each([
    ['anthropic', '/v1/models', 'after_id', (id: string, cursor?: string) => ({ data: [{ id }], has_more: !!cursor, last_id: cursor })],
    ['gemini', '/v1beta/models', 'pageToken', (id: string, cursor?: string) => ({ models: [{ name: `models/${id}` }], nextPageToken: cursor })],
  ] as const)('follows %s catalog pages without changing origin', async (apiFormat, path, parameter, page) => {
    const baseUrl = 'https://custom.example';
    const request = vi.fn(async () => Response.json(page('a')));
    const cursor = 'x&next=https://elsewhere.example';
    request.mockResolvedValueOnce(Response.json(page('z', cursor)));
    expect(await handleLlmModels({ provider: 'custom', baseUrl, apiFormat, apiKey: 'mock-key' }, request))
      .toEqual({ ok: true, models: ['a', 'z'] });
    const next = new URL(baseUrl + path);
    next.searchParams.set(parameter, cursor);
    expect(request).toHaveBeenNthCalledWith(2, next.href, expect.objectContaining({ redirect: 'error' }));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('bounds catalog requests with continually changing cursors', async () => {
    let page = 0;
    const request = vi.fn(async () => Response.json({ models: [{ name: 'models/demo' }], nextPageToken: String(++page) }));
    expect(await handleLlmModels({ provider: 'custom', baseUrl: 'https://custom.example', apiFormat: 'gemini' }, request))
      .toEqual({ ok: true, models: ['demo'] });
    expect(request).toHaveBeenCalledTimes(10);
  });
});
