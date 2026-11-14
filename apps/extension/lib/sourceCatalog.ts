import type { SourceId } from '@kiwi-search/core';
import type { MessageKey } from '@kiwi-search/app/i18n';

export type SourceGroup = 'web' | 'shopping' | 'academic' | 'video' | 'community' | 'image';

/** Keys of the texts a source can ask with before it is switched on (`source.confirm.<id>`). */
export type SourceConfirmKey = Extract<MessageKey, `source.confirm.${string}`>;

/** Keys of the names of the one-click presets (`preset.<group>.<id>`). */
export type PresetLabelKey = Extract<MessageKey, `preset.academic.${string}`>;

/** What a source adds, shown under its name, is the message `source.blurb.<id>`; its name is `source.label.<id>`. */
export interface SourceInfo {
  group: SourceGroup;
  /** Works only in a browser that is signed in to the site; the status shows "需要登录" until a search got through. */
  login?: boolean;
  /** Where the user signs in, in their own browser. */
  loginUrl?: string;
  /** An API key the source can't run without, or one that only raises its limits. */
  key?: 'required' | 'optional';
  /** Where to get that key. */
  keyUrl?: string;
  /** A server address the source needs (SearXNG). */
  baseUrl?: boolean;
  /** Off by default for a reason: turning it on asks first, with the message under this key as the reason. */
  confirm?: SourceConfirmKey;
}

/** The order the groups appear in. The words the page uses for them are `group.<id>.title` and `group.<id>.lead`. */
export const GROUPS: { id: SourceGroup }[] = [{ id: 'web' }, { id: 'shopping' }, { id: 'academic' }, { id: 'video' }, { id: 'community' }, { id: 'image' }];

/** Typed over `SourceId`, so a new source can't be left without a place on the settings page. Order inside a group is the order shown. */
export const SOURCE_INFO: Record<SourceId, SourceInfo> = {
  google: { group: 'web' },
  bing: { group: 'web' },
  duckduckgo: { group: 'web' },
  bravesearch: { group: 'web' },
  kagi: { group: 'web', loginUrl: 'https://kagi.com/signin', confirm: 'source.confirm.kagi' },
  baidu: { group: 'web', confirm: 'source.confirm.baidu' },
  sogou: { group: 'web' },
  yuanbao: { group: 'web' },
  yandex: { group: 'web' },
  brave: { group: 'web', key: 'required', keyUrl: 'https://brave.com/search/api/' },
  exa: { group: 'web', key: 'required', keyUrl: 'https://exa.ai' },
  deepseek: { group: 'web', key: 'required', keyUrl: 'https://platform.deepseek.com' },
  searxng: { group: 'web', baseUrl: true, key: 'optional' },
  taobao: { group: 'shopping', login: true, loginUrl: 'https://www.taobao.com' },
  jd: { group: 'shopping', login: true, loginUrl: 'https://www.jd.com' },
  amazon: { group: 'shopping', loginUrl: 'https://www.amazon.com' },
  scholar: { group: 'academic' },
  openalex: { group: 'academic', key: 'optional', keyUrl: 'https://openalex.org/settings/api' },
  arxiv: { group: 'academic' },
  pubmed: { group: 'academic', key: 'optional', keyUrl: 'https://account.ncbi.nlm.nih.gov/settings/' },
  europepmc: { group: 'academic' },
  dblp: { group: 'academic' },
  baiduxueshu: { group: 'academic' },
  cnki: { group: 'academic' },
  wos: { group: 'academic', login: true, loginUrl: 'https://www.webofscience.com' },
  crossref: { group: 'academic' },
  youtube: { group: 'video' },
  bilibili: { group: 'video' },
  douyin: { group: 'video', login: true, loginUrl: 'https://www.douyin.com' },
  zhihu: { group: 'community', login: true, loginUrl: 'https://www.zhihu.com/signin' },
  weixin: { group: 'community' },
  rednote: { group: 'community', login: true, loginUrl: 'https://www.rednote.com' },
  xiaohongshu: { group: 'community', login: true, loginUrl: 'https://www.xiaohongshu.com' },
  x: { group: 'community', login: true, loginUrl: 'https://x.com/login' },
  openverse: { group: 'image' },
};

/** Sources of one group, in display order. */
export function sourcesInGroup(group: SourceGroup): SourceId[] {
  return (Object.keys(SOURCE_INFO) as SourceId[]).filter((id) => SOURCE_INFO[id].group === group);
}

/** One-click sets for a group: turns these on and the rest of the group off. */
export interface SourcePreset {
  id: string;
  /** The key of the message that names the preset. */
  labelKey: PresetLabelKey;
  on: SourceId[];
}

export const GROUP_PRESETS: Partial<Record<SourceGroup, SourcePreset[]>> = {
  academic: [
    { id: 'general', labelKey: 'preset.academic.general', on: ['scholar', 'openalex', 'arxiv', 'crossref', 'pubmed'] },
    { id: 'medicine', labelKey: 'preset.academic.medicine', on: ['pubmed', 'europepmc', 'openalex', 'crossref', 'scholar'] },
    { id: 'cs', labelKey: 'preset.academic.cs', on: ['arxiv', 'dblp', 'openalex', 'scholar', 'crossref'] },
    { id: 'chinese', labelKey: 'preset.academic.chinese', on: ['baiduxueshu', 'cnki', 'scholar', 'openalex'] },
  ],
};
