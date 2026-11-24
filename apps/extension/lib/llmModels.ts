import { isLlmProvider, isLocalUrl, llmBaseUrl, LLM_PRESETS, type FetchLike } from '@kiwi-search/core';

export type LlmModelsReply =
  | { ok: true; models: string[] }
  | { ok: false; reason: 'address' | 'key' | 'ollamaOrigin' | 'http' | 'response' | 'network'; status?: number };

export async function handleLlmModels(message: unknown, request: FetchLike = fetch): Promise<LlmModelsReply> {
  if (!message || typeof message !== 'object') return { ok: false, reason: 'address' };
  const { provider, baseUrl, apiKey } = message as { provider?: unknown; baseUrl?: unknown; apiKey?: unknown };
  if (!isLlmProvider(provider)) return { ok: false, reason: 'address' };
  const base = provider === 'custom' || provider === 'ollama'
    ? (typeof baseUrl === 'string' ? llmBaseUrl(baseUrl) : '')
    : LLM_PRESETS[provider].baseUrl;
  if (!base || (provider === 'ollama' && !isLocalUrl(base))) return { ok: false, reason: 'address' };
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if ((provider === 'openai' || provider === 'deepseek') && !key) return { ok: false, reason: 'key' };
  const root = provider === 'ollama' || provider === 'deepseek' ? base.replace(/\/v1$/, '') : base;
  const url = root + (provider === 'ollama' ? '/api/tags' : '/models');
  try {
    const res = await request(url, {
      headers: provider !== 'ollama' && provider !== 'openrouter' && key ? { Authorization: `Bearer ${key}` } : {},
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (provider === 'ollama' && res.status === 403) return { ok: false, reason: 'ollamaOrigin' };
    if (!res.ok) return { ok: false, reason: 'http', status: res.status };
    const payload = await res.json().catch(() => null) as { models?: unknown; data?: unknown } | null;
    const entries = provider === 'ollama' ? payload?.models : payload?.data;
    if (!Array.isArray(entries)) return { ok: false, reason: 'response' };
    const models = entries.flatMap((entry: { id?: unknown; model?: unknown; name?: unknown } | null) => {
      const id = provider === 'ollama' ? entry?.model ?? entry?.name : entry?.id;
      const text = typeof id === 'string' ? id.trim() : '';
      return text && text.length <= 512 ? [text] : [];
    });
    return { ok: true, models: [...new Set(models)].sort((a, b) => a.localeCompare(b)) };
  } catch {
    return { ok: false, reason: 'network' };
  }
}
