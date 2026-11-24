import type { LlmApiFormat, LlmProfile, LlmProviderId, LlmSettings } from './types';
import { httpOrigin } from './url';

export const LLM_PROVIDERS = ['deepseek', 'openai', 'openrouter', 'ollama', 'custom'] as const;
export const LLM_API_FORMATS = ['chat-completions', 'responses', 'anthropic', 'gemini'] as const;

export function llmApiFormat(value: unknown): LlmApiFormat {
  return LLM_API_FORMATS.find((format) => format === value) ?? 'chat-completions';
}

export function inferLlmApiFormat(value: string): LlmApiFormat | undefined {
  const url = URL.parse(value);
  if (!url) return;
  if (/\/chat\/completions\/?$/.test(url.pathname)) return 'chat-completions';
  if (/\/responses\/?$/.test(url.pathname)) return 'responses';
  if (/\/messages\/?$/.test(url.pathname) || url.hostname === 'api.anthropic.com') return 'anthropic';
  if (/:(?:streamGenerateContent|generateContent)\/?$/.test(url.pathname) || url.hostname === 'generativelanguage.googleapis.com') return 'gemini';
}

export const LLM_PRESETS: Record<LlmProviderId, LlmProfile> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'openai/gpt-4o-mini' },
  ollama: { baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:14b' },
  custom: { baseUrl: '', apiKey: '', model: '' },
};

const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

export function isLocalUrl(url: string): boolean {
  return LOCAL_HOST.test(URL.parse(url)?.hostname ?? '');
}

export function isLlmProvider(value: unknown): value is LlmProviderId {
  return LLM_PROVIDERS.some((provider) => provider === value);
}

export function llmBaseUrl(value: string): string {
  const url = URL.parse(value);
  if (!url || !httpOrigin(value) || url.username || url.password || url.hash) return '';
  if (url.search) {
    if (!/:(?:streamGenerateContent)\/?$/.test(url.pathname) || url.search !== '?alt=sse') return '';
    url.search = '';
  }
  return url.href.replace(/\/+$/, '');
}

export function llmProfile(settings: LlmSettings, provider: LlmProviderId): LlmProfile {
  const preset = LLM_PRESETS[provider];
  const stored = settings.profiles?.[provider];
  const baseUrl = provider === 'custom' || provider === 'ollama' ? stored?.baseUrl ?? preset.baseUrl : preset.baseUrl;
  return { ...preset, ...stored, baseUrl };
}

export function profileLlmSettings(legacy: LlmSettings): LlmSettings {
  if (legacy.selection) return legacy;
  const baseUrl = llmBaseUrl(legacy.baseUrl);
  const isOllama = isLocalUrl(baseUrl) && /^http:\/\/[^/]+:11434(?:\/v1)?$/.test(baseUrl);
  const provider = LLM_PROVIDERS.find((id) => id !== 'custom' && id !== 'ollama' && LLM_PRESETS[id].baseUrl === baseUrl)
    ?? (isOllama && !legacy.apiKey ? 'ollama' : baseUrl === 'https://api.deepseek.com' ? 'deepseek' : 'custom');
  const apiKey = provider === 'ollama' ? '' : legacy.apiKey;
  const apiKeyOrigin = provider === 'custom' && apiKey ? httpOrigin(baseUrl) : undefined;
  return {
    ...LLM_PRESETS.deepseek,
    selection: { provider, model: legacy.model },
    profiles: { [provider]: { baseUrl: legacy.baseUrl, apiKey, model: legacy.model, ...(apiKeyOrigin ? { apiKeyOrigin } : {}) } },
  };
}

export function editLlmEndpoint(value: LlmSettings, baseUrl: string): Partial<LlmSettings> {
  const settings = profileLlmSettings(value);
  const { provider, model } = settings.selection!;
  const custom = settings.profiles?.custom;
  const apiFormat = inferLlmApiFormat(baseUrl) ?? (provider === 'custom' ? llmApiFormat(custom?.apiFormat) : 'chat-completions');
  return {
    profiles: { ...settings.profiles, custom: { ...custom, baseUrl, apiFormat, model } },
    ...(provider === 'custom' ? {} : { selection: { provider: 'custom', model } }),
  };
}

export function resolveLlmSettings(settings: LlmSettings): LlmProfile {
  if (!settings.selection) return settings;
  const { provider, model } = settings.selection;
  if (!isLlmProvider(provider)) return LLM_PRESETS.custom;
  const profile = llmProfile(settings, provider);
  const url = llmBaseUrl(profile.baseUrl);
  const baseUrl = provider === 'ollama'
    ? (isLocalUrl(url) ? url.replace(/(?:\/v1)?$/, '/v1') : '')
    : url;
  const origin = httpOrigin(baseUrl);
  const apiKey = provider === 'ollama' || !origin || (provider === 'custom' && origin !== profile.apiKeyOrigin)
    ? '' : profile.apiKey;
  return { baseUrl, model, apiKey, ...(provider === 'custom' && profile.apiFormat ? { apiFormat: llmApiFormat(profile.apiFormat) } : {}) };
}
