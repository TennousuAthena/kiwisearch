import { llmApiFormat } from './llmProfiles';
import type { LlmApiFormat } from './types';

export function llmApiRoot(baseUrl: string, format: LlmApiFormat): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|messages|models(?:\/[^/:]+:(?:streamGenerateContent|generateContent))?)$/, '');
  if (format === 'chat-completions' || !base) return base;
  const url = URL.parse(base);
  if (!url || url.pathname !== '/') return base;
  return base + (format === 'gemini' ? '/v1beta' : '/v1');
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
