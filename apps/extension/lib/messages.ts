import type { PipelineEvent, SourceId } from '@kiwi-search/core';

export type SearchRequest =
  | { type: 'search'; query: string; sources?: SourceId[]; summarize?: boolean }
  | { type: 'keepalive' };

export type PortMessage = { type: 'event'; event: PipelineEvent } | { type: 'fatal'; error: string };
