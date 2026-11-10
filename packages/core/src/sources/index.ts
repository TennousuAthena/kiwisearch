import type { SearchSource, SourceId } from '../types';
import { brave } from './brave';
import { deepseek } from './deepseek';
import { exa } from './exa';
import { openalex } from './openalex';
import { searxng } from './searxng';
import { browserSources } from '../engines';

export const SOURCES: Record<SourceId, SearchSource> = {
  ...browserSources,
  brave,
  exa,
  deepseek,
  openalex,
  searxng,
};

export const SOURCE_IDS = Object.keys(SOURCES) as SourceId[];

export { reconstructAbstract } from './openalex';
