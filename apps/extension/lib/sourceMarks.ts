import type { FusedResult, SourceId } from '@kiwi-search/core';
import type { MarkKey } from './sourceIcons';

/**
 * Which mark stands for each source, and the name it answers to on hover. Typed over `SourceId`, so a new source can't be
 * left without one. Two sources may share a mark (the two Xiaohongshu sites are one platform to the reader).
 */
export const SOURCE_MARKS: Record<SourceId, { mark: MarkKey; name: string }> = {
  google: { mark: 'google', name: 'Google' },
  bing: { mark: 'bing', name: 'Bing' },
  baidu: { mark: 'baidu', name: '百度' },
  yandex: { mark: 'yandex', name: 'Yandex' },
  duckduckgo: { mark: 'duckduckgo', name: 'DuckDuckGo' },
  scholar: { mark: 'scholar', name: 'Google 学术' },
  brave: { mark: 'brave', name: 'Brave' },
  exa: { mark: 'exa', name: 'Exa' },
  deepseek: { mark: 'deepseek', name: 'DeepSeek' },
  openalex: { mark: 'openalex', name: 'OpenAlex' },
  arxiv: { mark: 'arxiv', name: 'arXiv' },
  crossref: { mark: 'crossref', name: 'Crossref' },
  openverse: { mark: 'openverse', name: 'Openverse' },
  pubmed: { mark: 'pubmed', name: 'PubMed' },
  europepmc: { mark: 'europepmc', name: 'Europe PMC' },
  dblp: { mark: 'dblp', name: 'DBLP' },
  youtube: { mark: 'youtube', name: 'YouTube' },
  bilibili: { mark: 'bilibili', name: '哔哩哔哩' },
  zhihu: { mark: 'zhihu', name: '知乎' },
  xiaohongshu: { mark: 'xiaohongshu', name: '小红书' },
  rednote: { mark: 'xiaohongshu', name: '小红书' },
  sogou: { mark: 'sogou', name: '搜狗' },
  weixin: { mark: 'wechat', name: '微信公众号' },
  x: { mark: 'x', name: 'X' },
  searxng: { mark: 'searxng', name: 'SearXNG' },
};

export interface ResultMark {
  mark: MarkKey;
  name: string;
}

/** Opacity of the first, second and third mark; later ones stay folded until the row is hovered. */
export const MARK_FADE = [1, 0.65, 0.4] as const;

/**
 * The marks to show on a result: one per distinct engine that returned it, the best-ranked first. A result only one
 * engine found shows nothing; the marks mean "several engines agree".
 */
export function sourceMarks(sources: FusedResult['sources']): ResultMark[] {
  const marks: ResultMark[] = [];
  for (const { source } of [...sources].sort((a, b) => a.rank - b.rank)) {
    const entry = SOURCE_MARKS[source];
    if (entry && !marks.some((m) => m.mark === entry.mark)) marks.push(entry);
  }
  return marks.length >= 2 ? marks : [];
}

/** Spoken form of the marks. "收录", not "验证": engines agreeing is not a fact check. */
export function marksLabel(marks: ResultMark[]): string {
  return `${marks.map((m) => m.name).join('、')} 都收录了这条结果`;
}
