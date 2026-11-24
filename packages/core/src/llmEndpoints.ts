import { httpOrigin } from './url';
import type { LlmApiFormat } from './types';

const STREAM_OPERATION = /:streamGenerateContent\/?$/;
const GEMINI_OPERATION = /\/models\/[^/:]+:(?:streamGenerateContent|generateContent)$/;
const API_OPERATION = /\/(?:chat\/completions|responses|messages|models|api\/tags)$/;
const GEMINI_HOST = 'generativelanguage.googleapis.com';

export function llmBaseUrl(value: string): string {
  const url = URL.parse(value);
  if (!url || !httpOrigin(value) || url.username || url.password || url.hash) return '';
  if (url.search && (!STREAM_OPERATION.test(url.pathname) || url.search !== '?alt=sse')) return '';
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function inferLlmApiFormat(value: string): LlmApiFormat | undefined {
  const url = URL.parse(llmBaseUrl(value));
  if (!url) return;
  const path = url.pathname;
  if (path.endsWith('/responses')) return 'responses';
  if (path.endsWith('/chat/completions')) return 'chat-completions';
  if (path.endsWith('/messages')) return 'anthropic';
  if (GEMINI_OPERATION.test(path)) return 'gemini';
  if (url.hostname === 'api.anthropic.com') return 'anthropic';
  if (url.hostname === GEMINI_HOST) {
    return /(?:^|\/)openai(?:\/|$)/.test(path) ? 'chat-completions' : 'gemini';
  }
}

export function llmApiRoot(baseUrl: string, format: LlmApiFormat): string {
  const url = URL.parse(llmBaseUrl(baseUrl));
  if (!url) return '';
  const path = url.pathname.replace(/\/+$/, '');
  const prefix = path.replace(GEMINI_OPERATION.test(path) ? GEMINI_OPERATION : API_OPERATION, '');
  if (prefix !== path) return url.origin + prefix;
  if (!path) return url.origin + (format === 'gemini' ? '/v1beta' : url.hostname === 'openrouter.ai' ? '/api/v1' : '/v1');
  if (url.hostname === GEMINI_HOST && path === '/openai') return url.origin + '/v1beta/openai';
  return url.origin + (format === 'gemini' ? path.replace(/\/v1$/, '/v1beta') : path);
}

export function assertLlmRequestOrigin(baseUrl: string, endpoint: string): void {
  const origin = httpOrigin(baseUrl);
  if (!origin || origin !== httpOrigin(endpoint)) throw new Error('Invalid LLM request origin');
}

export function llmEndpoint(baseUrl: string, format: LlmApiFormat, model: string, stream: boolean): string {
  const root = llmApiRoot(baseUrl, format);
  if (!root) return '';
  if (format === 'anthropic') return root + '/messages';
  if (format === 'responses') return root + '/responses';
  if (format === 'gemini') {
    const id = encodeURIComponent(model.replace(/^models\//, ''));
    return `${root}/models/${id}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  }
  return root + '/chat/completions';
}

export function llmAuthHeaders(apiKey: string, apiFormat?: LlmApiFormat): Record<string, string> {
  switch (apiFormat) {
    case 'anthropic':
      return { 'anthropic-version': '2023-06-01', ...(apiKey ? { 'x-api-key': apiKey } : {}) };
    case 'gemini':
      return apiKey ? { 'x-goog-api-key': apiKey } : {};
    default:
      return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }
}
