import type { FusedResult, SourceId } from '@kiwi-search/core';
import { t } from './i18n';
import type { MarkKey } from './sourceIcons';

/**
 * Which mark stands for each source. Typed over `SourceId`, so a new source can't be left without one. Two sources may
 * share a mark (the two Xiaohongshu sites are one platform to the reader). The name a source answers to on hover is the
 * message `mark.<source>` (see `sourceName`).
 */
export const SOURCE_MARKS: Record<SourceId, { mark: MarkKey }> = {
  google: { mark: 'google' },
  bing: { mark: 'bing' },
  baidu: { mark: 'baidu' },
  yandex: { mark: 'yandex' },
  duckduckgo: { mark: 'duckduckgo' },
  scholar: { mark: 'scholar' },
  brave: { mark: 'brave' },
  // The same index by another route, so the same mark: a result both returned is not "two engines agreeing".
  bravesearch: { mark: 'brave' },
  kagi: { mark: 'kagi' },
  exa: { mark: 'exa' },
  deepseek: { mark: 'deepseek' },
  openalex: { mark: 'openalex' },
  arxiv: { mark: 'arxiv' },
  crossref: { mark: 'crossref' },
  openverse: { mark: 'openverse' },
  pubmed: { mark: 'pubmed' },
  europepmc: { mark: 'europepmc' },
  dblp: { mark: 'dblp' },
  baiduxueshu: { mark: 'baiduxueshu' },
  cnki: { mark: 'cnki' },
  wos: { mark: 'wos' },
  youtube: { mark: 'youtube' },
  bilibili: { mark: 'bilibili' },
  douyin: { mark: 'douyin' },
  taobao: { mark: 'taobao' },
  jd: { mark: 'jd' },
  amazon: { mark: 'amazon' },
  zhihu: { mark: 'zhihu' },
  xiaohongshu: { mark: 'xiaohongshu' },
  rednote: { mark: 'xiaohongshu' },
  sogou: { mark: 'sogou' },
  yuanbao: { mark: 'yuanbao' },
  weixin: { mark: 'wechat' },
  x: { mark: 'x' },
  searxng: { mark: 'searxng' },
};

/** The name a source answers to on hover, in the interface language; an id this table doesn't know is returned as it is. */
export function sourceName(source: SourceId): string {
  return SOURCE_MARKS[source] ? t(`mark.${source}`) : source;
}

export interface ResultMark {
  mark: MarkKey;
  name: string;
}

/** Opacity of the first, second and third mark; later ones stay folded until the row is hovered. */
export const MARK_FADE = [1, 0.65, 0.4] as const;

/**
 * The marks to show on a result: one per distinct engine that returned it, the best-ranked first. Several marks mean
 * "several engines agree". A result only one engine found gets that engine's mark too, but the page draws it faint
 * (`.src-marks.solo` in style.css): it says where the result came from and corroborates nothing.
 */
export function sourceMarks(sources: FusedResult['sources']): ResultMark[] {
  const marks: ResultMark[] = [];
  for (const { source } of [...sources].sort((a, b) => a.rank - b.rank)) {
    const entry = SOURCE_MARKS[source];
    if (entry && !marks.some((m) => m.mark === entry.mark)) marks.push({ mark: entry.mark, name: sourceName(source) });
  }
  return marks;
}

/** Spoken form of the marks. "收录", not "验证": engines agreeing is not a fact check. */
export function marksLabel(marks: ResultMark[]): string {
  return marks.length === 1
    ? t('newtab.marks.one', { name: marks[0].name })
    : t('newtab.marks.many', { names: marks.map((m) => m.name).join(t('newtab.marks.separator')) });
}
