import { assertLlmRequestOrigin, isLlmProvider, isLocalUrl, llmApiFormat, llmApiRoot, llmAuthHeaders, llmBaseUrl, LLM_PRESETS, ollamaApiMount, type FetchLike } from '@kiwi-search/core';

export type LlmModelsReply =
  | { ok: true; models: string[] }
  | { ok: false; reason: 'address' | 'key' | 'ollamaOrigin' | 'http' | 'response' | 'network'; status?: number };

const MODEL_PAGE_LIMIT = 10;
type ModelPage = {
  models?: unknown;
  data?: unknown;
  has_more?: unknown;
  last_id?: unknown;
  nextPageToken?: unknown;
};

export async function handleLlmModels(message: unknown, request: FetchLike = fetch): Promise<LlmModelsReply> {
  if (!message || typeof message !== 'object') return { ok: false, reason: 'address' };
  const { provider, baseUrl, apiKey, apiFormat } = message as { provider?: unknown; baseUrl?: unknown; apiKey?: unknown; apiFormat?: unknown };
  if (!isLlmProvider(provider)) return { ok: false, reason: 'address' };
  const base = provider === 'custom' || provider === 'ollama'
    ? (typeof baseUrl === 'string' ? llmBaseUrl(baseUrl) : '')
    : LLM_PRESETS[provider].baseUrl;
  if (!base || (provider === 'ollama' && !isLocalUrl(base))) return { ok: false, reason: 'address' };
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const format = provider === 'custom' ? llmApiFormat(apiFormat) : 'chat-completions';
  if ((provider === 'openai' || provider === 'deepseek') && !key) return { ok: false, reason: 'key' };
  const root = provider === 'ollama' ? ollamaApiMount(base)
    : provider === 'deepseek' ? base.replace(/\/v1$/, '') : llmApiRoot(base, format);
  const firstPage = root + (provider === 'ollama' ? '/api/tags' : '/models');
  try {
    const options = {
      headers: provider === 'ollama' || provider === 'openrouter' ? {} : llmAuthHeaders(key, format),
      credentials: 'omit' as const,
      redirect: 'error' as const,
      signal: AbortSignal.timeout(15_000),
    };
    const models = new Set<string>();
    const cursors = new Set<string>();
    let url = firstPage;
    for (let page = 0; page < MODEL_PAGE_LIMIT; page++) {
      assertLlmRequestOrigin(base, url);
      const res = await request(url, options);
      if (provider === 'ollama' && res.status === 403) return { ok: false, reason: 'ollamaOrigin' };
      if (!res.ok) return { ok: false, reason: 'http', status: res.status };
      const payload = await res.json().catch(() => null) as ModelPage | null;
      const entries = provider === 'ollama' || format === 'gemini' ? payload?.models : payload?.data;
      if (!Array.isArray(entries)) return { ok: false, reason: 'response' };
      for (const entry of entries) {
        if (format === 'gemini' && Array.isArray(entry?.supportedGenerationMethods) && !entry.supportedGenerationMethods.includes('generateContent')) continue;
        const id = provider === 'ollama' ? entry?.model ?? entry?.name
          : format === 'gemini' && typeof entry?.name === 'string' ? entry.name.replace(/^models\//, '') : entry?.id;
        const text = typeof id === 'string' ? id.trim() : '';
        if (text && text.length <= 512) models.add(text);
      }
      const cursor = format === 'gemini' ? payload?.nextPageToken
        : format === 'anthropic' && payload?.has_more === true ? payload.last_id : undefined;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
      const next = new URL(firstPage);
      next.searchParams.set(format === 'gemini' ? 'pageToken' : 'after_id', cursor);
      url = next.href;
    }
    return { ok: true, models: [...models].sort((a, b) => a.localeCompare(b)) };
  } catch {
    return { ok: false, reason: 'network' };
  }
}
