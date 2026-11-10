import { SOURCES } from './sources';
import type { FusionConfig, SourceId } from './types';

export const DEFAULT_CONFIG: FusionConfig = {
  sources: {
    google: { enabled: true },
    bing: { enabled: true },
    baidu: { enabled: true },
    yandex: { enabled: false },
    duckduckgo: { enabled: true },
    scholar: { enabled: true },
    brave: { enabled: true },
    exa: { enabled: true },
    deepseek: { enabled: true },
    openalex: { enabled: true },
    searxng: { enabled: false },
  },
  perSourceCount: 10,
  sourceTimeoutMs: 15000,
  renderer: { minIntervalMs: 3000, workerIdleMinutes: 10, focusOnCaptcha: true },
  rerank: { provider: 'llm', candidates: 30 },
  llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-flash' },
  summary: { enabled: true, provider: 'api', maxSources: 8, contentFetcher: 'direct', maxCharsPerSource: 3000 },
};

export function mergeConfig(base: FusionConfig, patch: DeepPartial<FusionConfig> | undefined): FusionConfig {
  if (!patch) return structuredClone(base);
  const sources = { ...base.sources };
  for (const [id, s] of Object.entries(patch.sources ?? {})) {
    sources[id as SourceId] = { ...(base.sources[id as SourceId] ?? { enabled: false }), ...(s as object) };
  }
  return {
    ...base,
    ...stripUndefined(patch),
    sources,
    rerank: { ...base.rerank, ...stripUndefined(patch.rerank) },
    renderer: { ...base.renderer, ...stripUndefined(patch.renderer) },
    llm: { ...base.llm, ...stripUndefined(patch.llm) },
    summary: { ...base.summary, ...stripUndefined(patch.summary) },
  } as FusionConfig;
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Sources that are enabled and have what they need to run in this environment. */
export function usableSources(config: FusionConfig, hasBrowser: boolean): { id: SourceId; reason?: string }[] {
  return (Object.keys(SOURCES) as SourceId[]).map((id) => {
    const src = SOURCES[id];
    const s = config.sources[id];
    if (!s?.enabled) return { id, reason: 'disabled' };
    if (src.requiresKey && !s.apiKey) return { id, reason: 'missing API key' };
    if (src.requiresBrowser && !hasBrowser) return { id, reason: 'needs browser extension' };
    if (id === 'searxng' && !s.baseUrl) return { id, reason: 'missing base URL' };
    return { id };
  });
}
