export type SourceId =
  | 'google'
  | 'bing'
  | 'baidu'
  | 'yandex'
  | 'duckduckgo'
  | 'scholar'
  | 'brave'
  | 'exa'
  | 'deepseek'
  | 'openalex'
  | 'searxng';

export type SourceKind = 'web' | 'ai' | 'academic';

export interface SearchHit {
  url: string;
  host?: string;
  title: string;
  snippet: string;
  source: SourceId;
  /** 1-based rank inside the source's own result list. */
  rank: number;
  content?: string;
  publishedAt?: string;
  meta?: HitMeta;
}

export interface HitMeta {
  authors?: string[];
  venue?: string;
  year?: number;
  citations?: number;
  doi?: string;
  siteName?: string;
  sourceScore?: number;
}

export interface FusedResult {
  /** Normalized URL, used as the dedup key. */
  key: string;
  url: string;
  host?: string;
  title: string;
  snippet: string;
  sources: { source: SourceId; rank: number }[];
  rrfScore: number;
  rerankScore?: number;
  /** Final score used for ordering, in [0, 1]. */
  score: number;
  late?: boolean;
  content?: string;
  publishedAt?: string;
  meta: HitMeta;
}

export interface SourceSettings {
  enabled: boolean;
  apiKey?: string;
  /** Base URL for self-hosted sources (SearXNG). */
  baseUrl?: string;
  /** RRF weight, default 1. */
  weight?: number;
}

export type RerankProvider = 'none' | 'llm' | 'jina' | 'cohere';
export type ContentFetcher = 'none' | 'direct' | 'jina';
export type SummaryProvider = 'api' | 'chrome-builtin';

export interface LlmSettings {
  /** OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface FusionConfig {
  sources: Partial<Record<SourceId, SourceSettings>>;
  perSourceCount: number;
  sourceTimeoutMs: number;
  renderer: {
    minIntervalMs: number;
    workerIdleMinutes: number;
    focusOnCaptcha: boolean;
  };
  rerank: {
    provider: RerankProvider;
    apiKey?: string;
    model?: string;
    /** How many fused candidates to send to the reranker. */
    candidates: number;
  };
  llm: LlmSettings;
  summary: {
    enabled: boolean;
    provider: SummaryProvider;
    /** How many top results are given to the LLM as context. */
    maxSources: number;
    contentFetcher: ContentFetcher;
    jinaApiKey?: string;
    maxCharsPerSource: number;
    /** Extra instructions appended to the system prompt. */
    instructions?: string;
  };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Env {
  fetch: FetchLike;
  runBrowserEngine?: (
    engine: BrowserEngine,
    query: string,
    opts: { count: number; signal: AbortSignal; onBlocked: (message: string) => void },
  ) => Promise<SearchHit[]>;
}

export interface SourceContext {
  env: Env;
  settings: SourceSettings;
  count: number;
  signal: AbortSignal;
  onBlocked: (message: string) => void;
}

export interface SearchSource {
  id: SourceId;
  label: string;
  kind: SourceKind;
  requiresKey: boolean;
  requiresBrowser?: boolean;
  search(query: string, ctx: SourceContext): Promise<SearchHit[]>;
}

export interface BrowserEngine {
  id: SourceId;
  label: string;
  kind: SourceKind;
  buildUrl(query: string, count: number): string;
  matches: string[];
  readySelector: string;
  blockedSelector: string;
  isBlockedUrl?(url: string): boolean;
  extract(doc: ParentNode, pageUrl: string): Omit<SearchHit, 'source'>[];
  resolve?(hits: SearchHit[], ctx: { fetch: FetchLike; signal: AbortSignal }): Promise<SearchHit[]>;
}

export type PipelineEvent =
  | { type: 'source_start'; source: SourceId }
  | { type: 'source_blocked'; source: SourceId; message: string }
  | { type: 'source_done'; source: SourceId; count: number; ms: number }
  | { type: 'source_error'; source: SourceId; error: string; ms: number }
  | { type: 'late_results'; source: SourceId; results: FusedResult[] }
  | { type: 'fused'; results: FusedResult[] }
  | { type: 'reranked'; results: FusedResult[]; provider: RerankProvider; error?: string }
  | { type: 'summary_start'; citations: Citation[] }
  | { type: 'summary_prompt'; citations: Citation[]; messages: import('./llm').ChatMessage[] }
  | { type: 'summary_delta'; text: string }
  | { type: 'summary_done'; text: string }
  | { type: 'summary_error'; error: string }
  | { type: 'done'; result: PipelineResult };

export interface Citation {
  n: number;
  url: string;
  title: string;
}

export interface PipelineResult {
  query: string;
  results: FusedResult[];
  summary?: string;
  citations: Citation[];
  sourceStats: { source: SourceId; count: number; ms: number; error?: string; status?: 'blocked' }[];
}

export interface RunOptions {
  /** Restrict to these sources (still must be enabled/usable). */
  sources?: SourceId[];
  summarize?: boolean;
  limit?: number;
  signal?: AbortSignal;
  onEvent?: (e: PipelineEvent) => void;
}
