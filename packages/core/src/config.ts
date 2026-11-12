import { DEFAULT_SYSTEMONE_ENDPOINT } from './decision';
import { SOURCES } from './sources';
import type { FusionConfig, Route, SearchMode, SourceId } from './types';

/**
 * Bump when a stored config has to be rewritten. New fields don't need it: `mergeConfig`
 * fills them from DEFAULT_CONFIG. Add the rewrite to MIGRATIONS under the version it upgrades from.
 */
export const CONFIG_VERSION = 5;

export const DEFAULT_CONFIG: FusionConfig = {
  version: CONFIG_VERSION,
  sources: {
    google: { enabled: true },
    bing: { enabled: true },
    yandex: { enabled: false },
    duckduckgo: { enabled: true },
    // Brave's own results page, read in the browser: no key. `brave` below is the API version of the same index and needs one; with
    // a key, turn one of the two off or Brave is counted twice in the fusion.
    bravesearch: { enabled: true },
    scholar: { enabled: true },
    brave: { enabled: true },
    exa: { enabled: true },
    deepseek: { enabled: true },
    openalex: { enabled: true },
    arxiv: { enabled: true },
    crossref: { enabled: true },
    openverse: { enabled: true },
    // PubMed is open and needs no key. The rest of the academic sources are opt-in: Europe PMC and DBLP overlap what is already on,
    // and the three browser ones (Baidu Scholar, CNKI, Web of Science) only return what the user's own browser session can see.
    pubmed: { enabled: true },
    europepmc: { enabled: false },
    dblp: { enabled: false },
    baiduxueshu: { enabled: false },
    cnki: { enabled: false },
    wos: { enabled: false },
    youtube: { enabled: true },
    bilibili: { enabled: true },
    zhihu: { enabled: true },
    // Mainland site and international site (RedNote): the same notes behind separate domains and logins; enable the one you are signed in to.
    xiaohongshu: { enabled: false },
    rednote: { enabled: true },
    // Sogou's web index overlaps Baidu's and its anti-spider is strict, so only the WeChat search (its real advantage) is on by default.
    sogou: { enabled: false },
    weixin: { enabled: true },
    x: { enabled: true },
    // Off, and last among the browser engines: its result page mixes in widgets (translate cards, recommendation lists) that read as results. The options page asks before it is turned on.
    baidu: { enabled: false },
    searxng: { enabled: false },
  },
  perSourceCount: 10,
  imageCount: 40,
  // A YouTube results page carries about 17 videos; asking for fewer lets the page finish as soon as it is read.
  videoCount: 16,
  noteCount: 12,
  sourceTimeoutMs: 15000,
  renderer: { minIntervalMs: 3000, workerIdleMinutes: 10, focusOnCaptcha: false },
  judge: {
    // A dedicated decision model is the recommended one (fast, cheap, built to answer exactly these questions): TypeSafe's Jev is the
    // preset and the user can point this at any System One-compatible service. Until a key is there, or when it fails, the user's chat
    // model decides instead (slower).
    provider: 'systemone',
    endpoint: DEFAULT_SYSTEMONE_ENDPOINT,
    apiKey: '',
    model: 'jev-latest',
    fallbackToLlm: true,
    llmShared: true,
    llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-flash' },
    candidates: 30,
    hideAbove: 0.7,
    hideIrrelevantBelow: 0.2,
    relevanceWeight: 0.75,
    timeoutMs: 12000,
    blockedDomains: [],
    boostedDomains: [],
    // Off until the user subscribes: a subscription is a request to a third-party host, so it is their call.
    blocklists: { recommended: [], subscriptions: [], custom: '' },
    rules: [],
  },
  intent: { enabled: true, threshold: 0.6, timeoutMs: 8000, autoSwitch: true, switchThreshold: 0.85 },
  // Needs the summary model (`llm`) to be set up; without one an academic search is the plain one.
  academic: { smart: true, timeoutMs: 12000, landmarks: 5 },
  // Off by default: a blocking LLM call per search, and its min-max scores can't be used to filter.
  rerank: { provider: 'none', candidates: 30 },
  llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-flash' },
  // The overview is written in the browser's language; `auto` follows the language of each query instead.
  summary: { enabled: true, provider: 'api', maxSources: 8, contentFetcher: 'direct', maxCharsPerSource: 3000, language: 'browser', languageCustom: '' },
};

type Migration = (stored: Record<string, unknown>) => Record<string, unknown>;

/** `MIGRATIONS[n]` upgrades a version-n config to version n + 1. */
const MIGRATIONS: Record<number, Migration> = {
  // Captcha pages no longer take over the screen by default. The options page had saved the old default (true) into every stored config.
  1: (stored) => ({ ...stored, renderer: { ...(stored.renderer as object | undefined), focusOnCaptcha: false } }),
  // Baidu is off by default now. The options page had saved the old default (on) into every stored config.
  2: (stored) => {
    const sources = stored.sources as { baidu?: object } | undefined;
    return { ...stored, sources: { ...sources, baidu: { ...sources?.baidu, enabled: false } } };
  },
  // The decision model may fall back to a chat model, which needs more time than System One: a settings page that had saved the
  // old defaults (6 s and 3 s) gets the new ones. The provider is called `systemone` now (TypeSafe is its preset).
  3: (stored) => {
    const judge = { ...(stored.judge as { provider?: string; timeoutMs?: number } | undefined) };
    const intent = { ...(stored.intent as { timeoutMs?: number } | undefined) };
    if (judge.timeoutMs === 6000) judge.timeoutMs = 12000;
    if (intent.timeoutMs === 3000) intent.timeoutMs = 8000;
    return renameTypesafe({ ...stored, judge, intent });
  },
  // `typesafe` became `systemone` (a version-4 config was only ever written by a development build).
  4: renameTypesafe,
};

function renameTypesafe(stored: Record<string, unknown>): Record<string, unknown> {
  const judge = stored.judge as { provider?: string } | undefined;
  return judge?.provider === 'typesafe' ? { ...stored, judge: { ...judge, provider: 'systemone' } } : stored;
}

/** Bring a stored config (unversioned means version 1) up to CONFIG_VERSION before merging. */
export function migrateConfig(stored: unknown): DeepPartial<FusionConfig> | undefined {
  if (!stored || typeof stored !== 'object') return undefined;
  let current = stored as Record<string, unknown>;
  let version = typeof current.version === 'number' ? current.version : 1;
  for (; version < CONFIG_VERSION; version++) current = MIGRATIONS[version]?.(current) ?? current;
  return { ...current, version: CONFIG_VERSION } as DeepPartial<FusionConfig>;
}

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
    judge: {
      ...base.judge,
      ...stripUndefined(patch.judge),
      llm: { ...base.judge.llm, ...stripUndefined(patch.judge?.llm) },
      blocklists: { ...base.judge.blocklists, ...stripUndefined(patch.judge?.blocklists) },
    },
    intent: { ...base.intent, ...stripUndefined(patch.intent) },
    academic: { ...base.academic, ...stripUndefined(patch.academic) },
    rerank: { ...base.rerank, ...stripUndefined(patch.rerank) },
    renderer: { ...base.renderer, ...stripUndefined(patch.renderer) },
    llm: { ...base.llm, ...stripUndefined(patch.llm) },
    summary: { ...base.summary, ...stripUndefined(patch.summary) },
    version: CONFIG_VERSION,
  } as FusionConfig;
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** The sources a routed intent switches on: those enabled and usable for the route's own mode. */
export function sourcesForRoutes(config: FusionConfig, hasBrowser: boolean, routes: Route[]): SourceId[] {
  const out: SourceId[] = [];
  for (const route of routes) {
    for (const source of usableSources(config, hasBrowser, route)) if (!source.reason && !out.includes(source.id)) out.push(source.id);
  }
  return out;
}

/** How many results to ask each source for in this mode. */
export function resultCount(config: FusionConfig, mode: SearchMode): number {
  if (mode === 'images') return config.imageCount;
  if (mode === 'video') return config.videoCount;
  if (mode === 'xiaohongshu') return config.noteCount;
  return config.perSourceCount;
}

/** Sources that are enabled and have what they need to run in this environment (and mode, if given). */
export function usableSources(
  config: FusionConfig,
  hasBrowser: boolean,
  mode?: SearchMode,
): { id: SourceId; modes: SearchMode[]; reason?: string }[] {
  return (Object.keys(SOURCES) as SourceId[]).map((id) => {
    const src = SOURCES[id];
    const s = config.sources[id];
    const base = { id, modes: src.modes };
    if (!s?.enabled) return { ...base, reason: 'disabled' };
    if (mode && !src.modes.includes(mode)) return { ...base, reason: `not available in ${mode} mode` };
    if (src.requiresKey && !s.apiKey) return { ...base, reason: 'missing API key' };
    if (src.requiresBrowser && !hasBrowser) return { ...base, reason: 'needs browser extension' };
    if (src.requiresBaseUrl && !s.baseUrl) return { ...base, reason: 'missing base URL' };
    return base;
  });
}
