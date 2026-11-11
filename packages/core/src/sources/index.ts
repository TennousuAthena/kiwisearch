import type { SearchSource, SourceId } from '../types';
import { arxiv } from './arxiv';
import { brave } from './brave';
import { crossref } from './crossref';
import { dblp } from './dblp';
import { deepseek } from './deepseek';
import { europepmc } from './europepmc';
import { exa } from './exa';
import { openalex } from './openalex';
import { openverse } from './openverse';
import { pubmed } from './pubmed';
import { searxng } from './searxng';
import { browserSources } from '../engines';

export const SOURCES: Record<SourceId, SearchSource> = {
  ...browserSources,
  brave,
  exa,
  deepseek,
  openalex,
  arxiv,
  crossref,
  openverse,
  pubmed,
  europepmc,
  dblp,
  searxng,
};

export const SOURCE_IDS = Object.keys(SOURCES) as SourceId[];

export { reconstructAbstract } from './openalex';
