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
  | 'arxiv'
  | 'crossref'
  | 'openverse'
  | 'pubmed'
  | 'europepmc'
  | 'dblp'
  | 'baiduxueshu'
  | 'cnki'
  | 'wos'
  | 'youtube'
  | 'bilibili'
  | 'zhihu'
  | 'xiaohongshu'
  | 'rednote'
  | 'sogou'
  | 'weixin'
  | 'x'
  | 'searxng';

export const SEARCH_MODES = ['web', 'images', 'video', 'academic', 'zhihu', 'xiaohongshu', 'wechat', 'x'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

/** The kinds of extra source the decision model can switch on during a general search. They are modes of their own too. */
export type Route = Extract<SearchMode, 'academic' | 'zhihu' | 'xiaohongshu' | 'wechat'>;

export function isSearchMode(value: unknown): value is SearchMode {
  return typeof value === 'string' && (SEARCH_MODES as readonly string[]).includes(value);
}

/**
 * Modes whose results are text pages: they can be judged by the decision model and summarized.
 * Image and video results are media tiles with a title at best, so those steps are skipped for them.
 */
export function modeHasText(mode: SearchMode): boolean {
  return mode === 'web' || mode === 'academic' || mode === 'zhihu' || mode === 'wechat';
}

/** An image result; the hit's `url` is then the page that shows it. */
export interface ImageInfo {
  /** Direct URL of the full-size image. */
  src: string;
  /** Small preview, loaded in the grid. */
  thumbnail: string;
  width?: number;
  height?: number;
  license?: string;
  creator?: string;
}

/** A video result; the hit's `url` is the watch page. Text fields are shown as the platform wrote them. */
export interface VideoInfo {
  thumbnail?: string;
  /** e.g. `8:16`. Missing for live streams. */
  duration?: string;
  channel?: string;
  channelUrl?: string;
  /** Already localized by the platform, e.g. `11,007 views` or `1.2万`; not meant to be parsed. */
  views?: string;
  /** Already localized, e.g. `2 years ago` or `昨天`. */
  published?: string;
}

/** A Xiaohongshu / RedNote note card: cover, author line and like count, as the platform printed them. */
export interface NoteInfo {
  cover?: string;
  /** Pixel size of the cover, for laying out the grid before images load. */
  width?: number;
  height?: number;
  author?: string;
  avatar?: string;
  /** Already localized, e.g. `昨天 19:00`. */
  time?: string;
  /** Already localized, e.g. `1211` or `10万+`. */
  likes?: string;
}

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
  image?: ImageInfo;
  video?: VideoInfo;
  note?: NoteInfo;
}

export interface HitMeta {
  authors?: string[];
  venue?: string;
  year?: number;
  citations?: number;
  doi?: string;
  /** Direct link to a full-text PDF, when the source knows one. */
  pdfUrl?: string;
  /** Community posts (Zhihu): a plain byline, deliberately not `authors`, which marks a result as a paper for de-duplication. */
  author?: string;
  votes?: number;
  comments?: number;
  reposts?: number;
  views?: number;
  /** Date as the platform printed it, e.g. `11-04`; not parsed. */
  age?: string;
  thumbnail?: string;
  siteName?: string;
  sourceScore?: number;
}

/** What the decision model said about one result. */
export interface Judgment {
  /** Expected relevance level, 0 (unrelated) to 3 (directly answers the query). */
  relevance: number;
  /** Probability that the page is content-farm, scraped or otherwise low-quality filler. */
  junk: number;
  /** Probability that the page matches each natural-language rule, in `judge.rules` order. */
  rules: number[];
}

export type HiddenReason =
  | { reason: 'blocked' }
  | { reason: 'junk' }
  | { reason: 'irrelevant' }
  | { reason: 'rule'; rule: string };

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
  /** Final score used for ordering; roughly 0-1 but only meaningful relative to the other results. */
  score: number;
  late?: boolean;
  judgment?: Judgment;
  /** Filtered out of the main list; kept so the UI can offer to show it. */
  hidden?: HiddenReason;
  content?: string;
  publishedAt?: string;
  meta: HitMeta;
  image?: ImageInfo;
  video?: VideoInfo;
  note?: NoteInfo;
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
export type JudgeProvider = 'none' | 'typesafe';
export type ContentFetcher = 'none' | 'direct' | 'jina';
export type SummaryProvider = 'api' | 'chrome-builtin';

export interface LlmSettings {
  /** OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface FusionConfig {
  /** Schema version of the stored config; see `migrateConfig`. */
  version: number;
  sources: Partial<Record<SourceId, SourceSettings>>;
  perSourceCount: number;
  /** Results requested per source in image mode. */
  imageCount: number;
  /** Results requested per source in video mode. */
  videoCount: number;
  /** Notes requested per source in the Xiaohongshu mode (the page shows about 12 before it loads more). */
  noteCount: number;
  sourceTimeoutMs: number;
  renderer: {
    minIntervalMs: number;
    workerIdleMinutes: number;
    focusOnCaptcha: boolean;
  };
  /** Decision-model filtering and ranking; when active it replaces `rerank`. */
  judge: {
    provider: JudgeProvider;
    apiKey: string;
    model: string;
    /** How many fused candidates are judged. */
    candidates: number;
    /** Probability at or above which a junk or rule question hides the result. */
    hideAbove: number;
    /** Normalized relevance (0-1) below which the result is hidden as irrelevant. */
    hideIrrelevantBelow: number;
    /** Weight of the judged relevance against the RRF prior when ordering. */
    relevanceWeight: number;
    /** Stop waiting for judgments after this long and use the ones that arrived. */
    timeoutMs: number;
    /** Always hidden; works without a decision model. */
    blockedDomains: string[];
    /** Ranked higher; works without a decision model. */
    boostedDomains: string[];
    /** Natural-language descriptions of results to hide, e.g. "scraped copies of Stack Overflow answers". */
    rules: string[];
  };
  /** Let the decision model choose, during a general search, which of academic / Zhihu / Xiaohongshu to search as well. Needs the judge. */
  intent: {
    enabled: boolean;
    /** Probability at or above which a route is switched on. */
    threshold: number;
    /** Stop waiting for the verdict after this long and search the general sources only. */
    timeoutMs: number;
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

/** Short-lived per-source result cache so reloads and mode switches don't re-hit rate-limited engines. */
export interface SourceCache {
  get(key: string): SearchHit[] | undefined;
  set(key: string, hits: SearchHit[]): void;
}

export interface BrowserRunOptions {
  mode: SearchMode;
  count: number;
  signal: AbortSignal;
  onBlocked: (message: string) => void;
  /** Call when the page actually starts loading, after queueing and rate limiting. */
  onStart: () => void;
  /** Renderer settings from the same config snapshot as the rest of the search. */
  renderer: FusionConfig['renderer'];
}

export interface Env {
  fetch: FetchLike;
  runBrowserEngine?: (engine: BrowserEngine, query: string, opts: BrowserRunOptions) => Promise<SearchHit[]>;
  cache?: SourceCache;
}

export interface SourceContext {
  env: Env;
  settings: SourceSettings;
  mode: SearchMode;
  count: number;
  signal: AbortSignal;
  onBlocked: (message: string) => void;
  onStart: () => void;
  renderer: FusionConfig['renderer'];
}

export interface SearchSource {
  id: SourceId;
  label: string;
  /** Search modes this source can serve. */
  modes: SearchMode[];
  requiresKey: boolean;
  requiresBaseUrl?: boolean;
  requiresBrowser?: boolean;
  search(query: string, ctx: SourceContext): Promise<SearchHit[]>;
}

export interface BrowserEngine {
  id: SourceId;
  label: string;
  modes: SearchMode[];
  buildUrl(query: string, count: number, mode: SearchMode): string;
  matches: string[];
  /** CSS selector list; a match means results have started to render (may cover several modes). */
  readySelector: string;
  blockedSelector: string;
  isBlockedUrl?(url: string): boolean;
  /** A gap between requests to this engine that is longer than the global `renderer.minIntervalMs`. */
  minIntervalMs?: number;
  extract(doc: ParentNode, pageUrl: string, mode: SearchMode): Omit<SearchHit, 'source'>[];
  resolve?(hits: SearchHit[], ctx: { fetch: FetchLike; signal: AbortSignal }): Promise<SearchHit[]>;
}

export type PipelineEvent =
  | { type: 'source_start'; source: SourceId }
  | { type: 'source_blocked'; source: SourceId; message: string }
  | { type: 'source_done'; source: SourceId; count: number; ms: number }
  | { type: 'source_error'; source: SourceId; error: string; ms: number }
  | { type: 'late_results'; source: SourceId; results: FusedResult[] }
  | { type: 'fused'; results: FusedResult[]; /** More sources are still running. */ partial?: boolean }
  | { type: 'reranked'; results: FusedResult[]; provider: RerankProvider; error?: string }
  | { type: 'routed'; routes: Route[]; scores: Partial<Record<Route, number>>; /** Set when no verdict could be had. */ error?: string }
  | { type: 'judged'; results: FusedResult[]; /** Set when some or all judgments failed. */ error?: string }
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
  mode: SearchMode;
  results: FusedResult[];
  summary?: string;
  citations: Citation[];
  /** `blocked`: waiting on a captcha; `late`: still running past the soft deadline. Both merge in later. */
  sourceStats: { source: SourceId; count: number; ms: number; error?: string; status?: 'blocked' | 'late' }[];
}

export interface RunOptions {
  mode?: SearchMode;
  /** Restrict to these sources (still must be enabled/usable). */
  sources?: SourceId[];
  /**
   * Stop waiting for slow sources after this long and let them merge in late.
   * Unset waits for every source (what MCP callers want).
   */
  softDeadlineMs?: number;
  summarize?: boolean;
  limit?: number;
  signal?: AbortSignal;
  onEvent?: (e: PipelineEvent) => void;
}
