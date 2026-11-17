import type { AcademicLanguage, FusedResult, NewsOptions, NewsSearchInfo, PipelineEvent, SearchMode, SourceId } from '@kiwi-search/core';

export type SearchRequest =
  | {
    type: 'search'; query: string; mode?: SearchMode; language?: AcademicLanguage; news?: Partial<NewsOptions>; refresh?: boolean; sources?: SourceId[]; summarize?: boolean;
    /** The page understands the early and final overview (a `phase` on overview events, and `summary_checked`). Without it the extension writes one overview, as before. */
    phases?: boolean;
  }
  | { type: 'stop-summary' }
  | { type: 'keepalive' };

export interface SummaryRequest {
  type: 'summarize'; query: string; mode: SearchMode; results: FusedResult[];
  news?: NewsSearchInfo; reuse?: boolean; summaryAt?: string;
}

export type PortMessage =
  | { type: 'event'; event: PipelineEvent }
  | { type: 'fatal'; error: string }
  | { type: 'readiness'; enabled: number; ready: number }
  | { type: 'summary-snapshot'; results: FusedResult[]; summaryAt: string };
