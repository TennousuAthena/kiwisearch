import { httpOrigin, isLocalUrl } from './url';
import type { LlmApiFormat, LlmProfile } from './types';

const STREAM_OPERATION = /:streamGenerateContent\/?$/;
const GEMINI_OPERATION = /\/models\/[^/:]+:(?:streamGenerateContent|generateContent)$/;
const API_OPERATION = /\/(?:chat\/completions|responses|messages|models|api\/tags)$/;
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const ANTHROPIC_HOST = 'api.anthropic.com';
const OPENAI_COMPATIBLE_HOSTS = new Set(['openrouter.ai', 'api.deepseek.com', 'api.openai.com']);

export function llmBaseUrl(value: string): string {
  const url = URL.parse(value);
  if (!url || !httpOrigin(value) || url.username || url.password || url.hash) return '';
  if (url.search && (!STREAM_OPERATION.test(url.pathname) || url.search !== '?alt=sse')) return '';
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function inferLlmApiFormat(value: string, previous?: Partial<Pick<LlmProfile, 'baseUrl' | 'apiFormat'>>): LlmApiFormat | undefined {
  const url = URL.parse(llmBaseUrl(value));
  if (url) {
    const { pathname: path, hostname, port } = url;
    if (path.endsWith('/responses')) return 'responses';
    if (path.endsWith('/chat/completions')) return 'chat-completions';
    if (path.endsWith('/messages')) return 'anthropic';
    if (GEMINI_OPERATION.test(path)) return 'gemini';
    if (hostname === ANTHROPIC_HOST) return 'anthropic';
    const geminiOpenAi = hostname === GEMINI_HOST && /(?:^|\/)openai(?:\/|$)/.test(path);
    if (hostname === GEMINI_HOST && !geminiOpenAi) return 'gemini';
    if (geminiOpenAi || OPENAI_COMPATIBLE_HOSTS.has(hostname) || (port === '11434' && isLocalUrl(url.href))) {
      return previous?.apiFormat === 'responses' ? 'responses' : 'chat-completions';
    }
  }
  if (previous?.apiFormat === 'gemini' || previous?.apiFormat === 'anthropic') {
    const previousHost = URL.parse(previous.baseUrl ?? '')?.hostname;
    if ((previousHost === GEMINI_HOST || previousHost === ANTHROPIC_HOST) && URL.parse(value)?.hostname !== previousHost) {
      return 'chat-completions';
    }
  }
}

export function llmApiRoot(baseUrl: string, format: LlmApiFormat): string {
  const url = URL.parse(llmBaseUrl(baseUrl));
  if (!url) return '';
  const path = url.pathname.replace(/\/+$/, '');
  const prefix = path.replace(GEMINI_OPERATION.test(path) ? GEMINI_OPERATION : API_OPERATION, '');
  if (prefix !== path) return url.origin + prefix;
  if (url.hostname === 'openrouter.ai' && path === '/api') return url.origin + '/api/v1';
  if (!path) return url.origin + (format === 'gemini' ? '/v1beta' : url.hostname === 'openrouter.ai' ? '/api/v1' : '/v1');
  if (url.hostname === GEMINI_HOST && path === '/openai') return url.origin + '/v1beta/openai';
  return url.origin + (format === 'gemini' ? path.replace(/\/v1$/, '/v1beta') : path);
}

export function ollamaApiMount(baseUrl: string): string {
  const url = URL.parse(llmBaseUrl(baseUrl));
  if (!url) return '';
  return url.origin + url.pathname.replace(/\/+$/, '').replace(API_OPERATION, '').replace(/\/v1$/, '');
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
