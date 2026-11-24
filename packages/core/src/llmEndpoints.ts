import { llmApiFormat, llmBaseUrl } from './llmProfiles';
import { httpOrigin } from './url';
import type { LlmApiFormat } from './types';

export function llmApiRoot(baseUrl: string, format: LlmApiFormat): string {
  const url = URL.parse(llmBaseUrl(baseUrl));
  if (!url) return '';
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|messages|models(?:\/[^/:]+:(?:streamGenerateContent|generateContent))?)$/, '');
  return url.origin + (path || (format === 'gemini' ? '/v1beta' : format === 'chat-completions' ? '' : '/v1'));
}

export function assertLlmRequestOrigin(baseUrl: string, endpoint: string): void {
  const origin = httpOrigin(baseUrl);
  if (!origin || origin !== httpOrigin(endpoint)) throw new Error('Invalid LLM request origin');
}

export function llmEndpoint(baseUrl: string, format: LlmApiFormat, model: string, stream: boolean): string {
  const root = llmApiRoot(baseUrl, format);
  if (format === 'anthropic') return root + '/messages';
  if (format === 'responses') return root + '/responses';
  if (format === 'gemini') {
    const id = encodeURIComponent(model.replace(/^models\//, ''));
    return `${root}/models/${id}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  }
  return root + '/chat/completions';
}

export function llmAuthHeaders(apiKey: string, apiFormat?: LlmApiFormat): Record<string, string> {
  switch (llmApiFormat(apiFormat)) {
    case 'anthropic':
      return { 'anthropic-version': '2023-06-01', ...(apiKey ? { 'x-api-key': apiKey } : {}) };
    case 'gemini':
      return apiKey ? { 'x-goog-api-key': apiKey } : {};
    default:
      return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  }
}
