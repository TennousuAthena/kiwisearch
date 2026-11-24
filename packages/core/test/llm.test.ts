import { describe, expect, it, vi } from 'vitest';
import { chat, chatStream } from '../src/llm';
import { llmApiRoot, llmBaseUrl, llmEndpoint } from '../src/llmEndpoints';
import { editLlmEndpoint, profileLlmSettings, resolveLlmSettings } from '../src/llmProfiles';
import type { LlmApiFormat } from '../src/types';

describe('chatStream', () => {
  it('parses fragmented SSE events and a final event without a trailing newline', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\ndata: [DONE]',
    ];
    const fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    const output: string[] = [];
    for await (const delta of chatStream(fetch, { baseUrl: 'https://api.example/v1', apiKey: '', model: 'test' }, [])) output.push(delta);
    expect(output.join('')).toBe('Hello world');
  });
});

describe('custom API formats', () => {
  it.each(['http://models', 'http://models:8080'])('keeps chat and stream credentials on %s', async (baseUrl) => {
    const settings = profileLlmSettings({ baseUrl, apiKey: 'mock-key', model: 'demo' });
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({}));
    await chat(fetch, settings, []);
    fetch.mockResolvedValueOnce(new Response('data: [DONE]\n'));
    for await (const _ of chatStream(fetch, settings, [])) { /* no content */ }
    expect(fetch.mock.calls).toHaveLength(2);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe(baseUrl + '/v1/chat/completions');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer mock-key');
    }
  });

  const messages = [{ role: 'system', content: 'Return JSON.' }, { role: 'user', content: 'Answer.' }] as const;
  const formats = [
    {
      format: 'chat-completions', baseUrl: 'https://api.example/chat/completions', path: '/chat/completions',
      auth: { Authorization: 'Bearer mock-key' },
      request: { model: 'demo', messages, response_format: { type: 'json_object' } },
      response: { choices: [{ message: { role: 'assistant', content: 'answer' } }] },
      events: [{ choices: [{ delta: { content: 'answer' } }] }],
    },
    {
      format: 'responses', baseUrl: 'https://api.example/v1/responses', path: '/v1/responses',
      auth: { Authorization: 'Bearer mock-key' },
      request: { model: 'demo', instructions: 'Return JSON.', input: [messages[1]], text: { format: { type: 'json_object' } } },
      response: { output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] },
      events: [{ type: 'response.created' }, { type: 'response.output_text.delta', delta: 'answer' }, { type: 'response.completed' }],
    },
    {
      format: 'anthropic', baseUrl: 'https://api.example/v1/messages', path: '/v1/messages',
      auth: { 'x-api-key': 'mock-key', 'anthropic-version': '2023-06-01' },
      request: { model: 'demo', system: 'Return JSON.', messages: [messages[1]], max_tokens: 4096 },
      response: { type: 'message', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'answer' }] },
      events: [{ type: 'message_start' }, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hidden' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }, { type: 'message_stop' }],
    },
    {
      format: 'gemini', baseUrl: 'https://api.example/v1/models/example:streamGenerateContent?alt=sse',
      path: '/v1/models/demo:generateContent', streamPath: '/v1/models/demo:streamGenerateContent?alt=sse',
      auth: { 'x-goog-api-key': 'mock-key' },
      request: { systemInstruction: { parts: [{ text: 'Return JSON.' }] }, contents: [{ role: 'user', parts: [{ text: 'Answer.' }] }],
        generationConfig: { responseMimeType: 'application/json' } },
      response: { candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'hidden' }, { text: 'answer' }] } }] },
      events: [{ candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] } }] }],
    },
  ] satisfies Array<{
    format: LlmApiFormat; baseUrl: string; path: string; streamPath?: string; auth: Record<string, string>;
    request: object; response: object; events: object[];
  }>;

  it.each(formats)('sends and reads $format chat and stream requests', async ({ format, baseUrl, path, streamPath, auth, request, response, events }) => {
    const model = format === 'gemini' ? 'models/demo' : 'demo';
    const settings = {
      ...profileLlmSettings({ baseUrl, apiKey: '', model }),
      selection: { provider: 'custom' as const, model },
      profiles: { custom: { baseUrl, apiFormat: format, apiKey: 'mock-key', apiKeyOrigin: 'https://api.example' } },
    };
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json(response));
    expect(await chat(fetch, settings, [...messages], { json: true })).toBe('answer');
    const checkRequest = (url: string) => {
      const [actual, init] = fetch.mock.lastCall!;
      expect(actual).toBe('https://api.example' + url);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
      const headers = new Headers(init?.headers);
      for (const [header, value] of Object.entries(auth)) expect(headers.get(header)).toBe(value);
      const actualCredentials = ['authorization', 'x-api-key', 'x-goog-api-key'].filter((header) => headers.has(header));
      expect(actualCredentials).toHaveLength(1);
      return JSON.parse(init?.body as string);
    };
    expect(checkRequest(path)).toMatchObject(request);
    fetch.mockResolvedValueOnce(new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('')));
    const output: string[] = [];
    for await (const delta of chatStream(fetch, settings, [...messages])) output.push(delta);
    expect(output).toEqual(['answer']);
    const streamBody = checkRequest(streamPath ?? path);
    if (format !== 'gemini') expect(streamBody).toMatchObject({ stream: true });
  });

  it('switches a preset endpoint to custom without copying the preset credential', () => {
    const preset = profileLlmSettings({ baseUrl: 'https://api.openai.com/v1', apiKey: 'mock-openai', model: 'keep-model' });
    const next = { ...preset, ...editLlmEndpoint(preset, 'https://proxy.example/v1/responses') };
    expect(next.selection).toEqual({ provider: 'custom', model: 'keep-model' });
    expect(resolveLlmSettings(next)).toEqual({
      baseUrl: 'https://proxy.example/v1/responses', model: 'keep-model', apiKey: '', apiFormat: 'responses',
    });
    expect(next.profiles?.openai?.apiKey).toBe('mock-openai');
  });
});

describe('LLM API addresses', () => {
  it.each(['/gateway/v2', '/gateway/v2/v1', '/gateway/v2/v1/chat/completions', '/gateway/v2/api/tags'])(
    'uses Ollama /v1 below the mounted override %s',
    async (path) => {
      const settings = {
        baseUrl: '', model: 'demo', apiKey: '',
        selection: { provider: 'ollama' as const, model: 'demo' },
        profiles: { ollama: { baseUrl: 'http://localhost:11434' + path, apiKey: 'mock-must-not-send' } },
      };
      const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ choices: [{ message: { content: 'ok' } }] }));
      expect(await chat(fetch, settings, [])).toBe('ok');
      const [url, init] = fetch.mock.lastCall!;
      expect(url).toBe('http://localhost:11434/gateway/v2/v1/chat/completions');
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    },
  );

  it('can change the selected format without changing the saved version', () => {
    const baseUrl = llmBaseUrl('https://gateway.example/v1/');
    const saved: Parameters<typeof resolveLlmSettings>[0] = {
      baseUrl: '', model: 'demo', apiKey: '',
      selection: { provider: 'custom', model: 'demo' },
      profiles: { custom: { baseUrl, apiFormat: 'gemini' } },
    };
    const gemini = resolveLlmSettings(saved);
    expect(gemini.baseUrl).toBe('https://gateway.example/v1');
    expect(llmEndpoint(gemini.baseUrl, gemini.apiFormat!, gemini.model, false))
      .toBe('https://gateway.example/v1beta/models/demo:generateContent');
    saved.profiles!.custom!.apiFormat = 'chat-completions';
    const chatCompletion = resolveLlmSettings(saved);
    expect(llmEndpoint(chatCompletion.baseUrl, chatCompletion.apiFormat!, chatCompletion.model, false))
      .toBe('https://gateway.example/v1/chat/completions');
  });

  it.each([
    ['https://gateway.example', 'chat-completions', 'https://gateway.example/v1', '/chat/completions'],
    ['https://gateway.example/openai', 'chat-completions', 'https://gateway.example/openai', '/chat/completions'],
    ['https://gateway.example/chat/completions', 'chat-completions', 'https://gateway.example', '/chat/completions'],
    ['https://gateway.example/openai/v1/chat/completions/', 'chat-completions', 'https://gateway.example/openai/v1', '/chat/completions'],
    ['https://gateway.example/api/v3/responses', 'responses', 'https://gateway.example/api/v3', '/responses'],
    ['https://gateway.example/proxy/v1/models', 'anthropic', 'https://gateway.example/proxy/v1', '/messages'],
    ['https://api.anthropic.com/v1/messages', 'anthropic', 'https://api.anthropic.com/v1', '/messages'],
    ['https://openrouter.ai', 'chat-completions', 'https://openrouter.ai/api/v1', '/chat/completions'],
    ['https://openrouter.ai/api/', 'chat-completions', 'https://openrouter.ai/api/v1', '/chat/completions'],
    ['https://openrouter.ai/api/chat/completions', 'chat-completions', 'https://openrouter.ai/api', '/chat/completions'],
    ['https://gateway.example/api', 'chat-completions', 'https://gateway.example/api', '/chat/completions'],
    ['https://openrouter.ai/api/v1', 'chat-completions', 'https://openrouter.ai/api/v1', '/chat/completions'],
    ['https://gateway.example/proxy/v1', 'gemini', 'https://gateway.example/proxy/v1beta', '/models/demo:generateContent'],
    ['https://gateway.example/v1/models/old:generateContent', 'gemini', 'https://gateway.example/v1', '/models/demo:generateContent'],
    ['https://generativelanguage.googleapis.com/v1beta/models/old:streamGenerateContent?alt=sse', 'gemini',
      'https://generativelanguage.googleapis.com/v1beta', '/models/demo:generateContent'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'chat-completions',
      'https://generativelanguage.googleapis.com/v1beta/openai', '/chat/completions'],
    ['https://generativelanguage.googleapis.com/openai', 'chat-completions', 'https://generativelanguage.googleapis.com/v1beta/openai', '/chat/completions'],
  ] as const)('normalizes %s as %s', (address, format, root, operation) => {
    expect(llmApiRoot(address, format)).toBe(root);
    expect(llmEndpoint(address, format, 'models/demo', false)).toBe(root + operation);
    expect(llmEndpoint(address, format, 'models/demo', true))
      .toBe(root + (format === 'gemini' ? '/models/demo:streamGenerateContent?alt=sse' : operation));
  });

  it.each([
    ['https://api.anthropic.com', 'anthropic'],
    ['https://generativelanguage.googleapis.com/v1', 'gemini'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/models', 'chat-completions'],
    ['https://generativelanguage.googleapis.com/v1beta/openai/responses', 'responses'],
    ['https://gateway.example/v1/responses', 'responses'],
    ['https://openrouter.ai/api/', 'chat-completions'],
    ['https://api.openai.com/v1', 'chat-completions'],
    ['https://api.deepseek.com/v1', 'chat-completions'],
    ['http://localhost:11434/v1', 'chat-completions'],
    ['http://127.0.0.1:11434/v1', 'chat-completions'],
    ['http://[::1]:11434/v1', 'chat-completions'],
    ['https://api.openai.com/v1/responses', 'responses'],
    ['https://openrouter.ai/api/v1/messages', 'anthropic'],
  ] as const)('infers the format only when editing %s', (baseUrl, format) => {
    const savedFormat = format === 'gemini' ? 'anthropic' : 'gemini';
    const saved = {
      baseUrl: '', model: 'demo', apiKey: '',
      selection: { provider: 'custom' as const, model: 'demo' },
      profiles: { custom: { baseUrl, apiFormat: savedFormat, apiKey: 'mock-key', apiKeyOrigin: 'https://different.example' } },
    } satisfies Parameters<typeof resolveLlmSettings>[0];
    expect(resolveLlmSettings(saved)).toMatchObject({ apiFormat: savedFormat, apiKey: '' });
    expect(editLlmEndpoint(saved, baseUrl).profiles?.custom?.apiFormat).toBe(format);
  });

  it.each([
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini', ['https://gateway.example/v1'], 'chat-completions'],
    ['https://api.anthropic.com/v1', 'anthropic', ['', 'https://gateway.example/v1'], 'chat-completions'],
    ['https://api.anthropic.com/v1', 'anthropic', ['https://gateway.example/v1/responses'], 'responses'],
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini', ['https://gateway.example/v1/messages'], 'anthropic'],
    ['https://gateway.example/v1', 'anthropic', ['https://gateway.example/prefix/v1'], 'anthropic'],
    ['https://gateway.example/v1', 'gemini', ['https://other-gateway.example/v1'], 'gemini'],
  ] as const)('handles a %s %s connection edited to %j', (baseUrl, apiFormat, edits, expected) => {
    let settings: Parameters<typeof resolveLlmSettings>[0] = {
      baseUrl: '', model: 'demo', apiKey: '',
      selection: { provider: 'custom', model: 'demo' },
      profiles: { custom: { baseUrl, apiFormat } },
    };
    for (const address of edits) settings = { ...settings, ...editLlmEndpoint(settings, address) };
    expect(resolveLlmSettings(settings).apiFormat).toBe(expected);
  });

  it.each([
    ['https://api.openai.com/v1/', 'responses', 'https://api.openai.com/v1/responses'],
    ['https://openrouter.ai/api/', 'responses', 'https://openrouter.ai/api/v1/responses'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'chat-completions',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'],
    ['https://api.openai.com/v1/chat/completions/', 'chat-completions', 'https://api.openai.com/v1/chat/completions'],
  ] as const)('resolves an address edit to %s from a selected Responses format', (address, format, endpoint) => {
    const settings: Parameters<typeof resolveLlmSettings>[0] = {
      baseUrl: '', model: 'demo', apiKey: '',
      selection: { provider: 'custom', model: 'demo' },
      profiles: { custom: { baseUrl: 'https://api.openai.com/v1', apiFormat: 'responses' } },
    };
    const edited = resolveLlmSettings({ ...settings, ...editLlmEndpoint(settings, address) });
    expect(edited.apiFormat).toBe(format);
    expect(llmEndpoint(edited.baseUrl, format, edited.model, false)).toBe(endpoint);
  });

  it.each([
    'https://user:secret@gateway.example',
    'https://gateway.example/v1#fragment',
    'https://gateway.example/v1beta/models/old:streamGenerateContent?alt=sse&key=secret',
  ])('does not resolve an endpoint from a URL with credentials, a fragment, or an unexpected query', (address) => {
    expect(llmEndpoint(address, 'gemini', 'demo', true)).toBe('');
  });
});
