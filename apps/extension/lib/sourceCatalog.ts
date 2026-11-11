import type { SourceId } from '@kiwi-search/core';

export type SourceGroup = 'web' | 'academic' | 'video' | 'community' | 'image';

export interface SourceInfo {
  group: SourceGroup;
  /** One line on what the source adds, shown under its name. */
  blurb: string;
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
  /** Off by default for a reason: turning it on asks first, with this as the reason. */
  confirm?: string;
}

/** The order the groups appear in, with the words the page uses for them. */
export const GROUPS: { id: SourceGroup; title: string; lead: string }[] = [
  { id: 'web', title: '网页', lead: '通用网页搜索。开得越多，结果越全，也越慢一点。' },
  { id: 'academic', title: '学术', lead: '论文、预印本和引用。' },
  { id: 'video', title: '视频', lead: '“视频”标签用到的来源。' },
  { id: 'community', title: '社区', lead: '平台里的讨论和笔记，用的是你这个浏览器里已有的登录状态。' },
  { id: 'image', title: '图片', lead: '“图片”标签用到的来源（Bing 也提供图片，在网页里）。' },
];

/** Typed over `SourceId`, so a new source can't be left without a place on the settings page. Order inside a group is the order shown. */
export const SOURCE_INFO: Record<SourceId, SourceInfo> = {
  google: { group: 'web', blurb: '覆盖面最广的网页搜索' },
  bing: { group: 'web', blurb: '网页和图片搜索' },
  duckduckgo: { group: 'web', blurb: '不追踪的网页搜索' },
  baidu: {
    group: 'web',
    blurb: '中文网页',
    confirm: '百度的结果页里混有翻译、推荐等并不是搜索结果的卡片，开启后它们会出现在你的搜索结果里。默认关闭，之后随时可以再关掉。',
  },
  sogou: { group: 'web', blurb: '搜狗网页搜索，和百度的索引有重叠' },
  yandex: { group: 'web', blurb: '俄语和东欧网页' },
  brave: { group: 'web', blurb: 'Brave 自己的独立索引', key: 'required', keyUrl: 'https://brave.com/search/api/' },
  exa: { group: 'web', blurb: '按语义找页面', key: 'required', keyUrl: 'https://exa.ai' },
  deepseek: { group: 'web', blurb: 'DeepSeek 联网搜索', key: 'required', keyUrl: 'https://platform.deepseek.com' },
  searxng: { group: 'web', blurb: '你自己搭的 SearXNG 实例', baseUrl: true, key: 'optional' },
  scholar: { group: 'academic', blurb: 'Google 学术，覆盖最全' },
  openalex: { group: 'academic', blurb: '开放学术图谱，带引用数；不填 Key 也能用', key: 'optional', keyUrl: 'https://openalex.org/settings/api' },
  arxiv: { group: 'academic', blurb: '预印本，计算机和物理的最新论文' },
  pubmed: { group: 'academic', blurb: '生物医学文献（NCBI 官方接口）；填你自己的 Key 可以提高速率', key: 'optional', keyUrl: 'https://account.ncbi.nlm.nih.gov/settings/' },
  europepmc: { group: 'academic', blurb: '欧洲生命科学文献，含预印本和开放获取全文' },
  dblp: { group: 'academic', blurb: '计算机领域的论文和会议（有的网络下会被它的验证页挡住）' },
  baiduxueshu: { group: 'academic', blurb: '百度学术，中文文献覆盖好；偶尔要人机验证' },
  cnki: { group: 'academic', blurb: '知网：中文期刊和学位论文，用你自己的校园网或账号；常要滑块验证' },
  wos: { group: 'academic', blurb: 'Web of Science：用你所在机构的访问权限或你的账号登录后才有结果', login: true, loginUrl: 'https://www.webofscience.com' },
  crossref: { group: 'academic', blurb: '出版商登记的元数据和 DOI' },
  youtube: { group: 'video', blurb: '全球视频' },
  bilibili: { group: 'video', blurb: '中文视频' },
  zhihu: { group: 'community', blurb: '问答和长文', login: true, loginUrl: 'https://www.zhihu.com/signin' },
  weixin: { group: 'community', blurb: '微信公众号文章（经搜狗微信，无需登录）' },
  rednote: { group: 'community', blurb: '小红书国际站的笔记', login: true, loginUrl: 'https://www.rednote.com' },
  xiaohongshu: { group: 'community', blurb: '小红书国内站的笔记', login: true, loginUrl: 'https://www.xiaohongshu.com' },
  x: { group: 'community', blurb: '推文；只在你打开“X”标签时才访问', login: true, loginUrl: 'https://x.com/login' },
  openverse: { group: 'image', blurb: '可自由使用的开放授权图片' },
};

/** Sources of one group, in display order. */
export function sourcesInGroup(group: SourceGroup): SourceId[] {
  return (Object.keys(SOURCE_INFO) as SourceId[]).filter((id) => SOURCE_INFO[id].group === group);
}

/** One-click sets for a group: turns these on and the rest of the group off. */
export interface SourcePreset {
  id: string;
  label: string;
  on: SourceId[];
}

export const GROUP_PRESETS: Partial<Record<SourceGroup, SourcePreset[]>> = {
  academic: [
    { id: 'general', label: '综合', on: ['scholar', 'openalex', 'arxiv', 'crossref', 'pubmed'] },
    { id: 'medicine', label: '医学', on: ['pubmed', 'europepmc', 'openalex', 'crossref', 'scholar'] },
    { id: 'cs', label: '计算机', on: ['arxiv', 'dblp', 'openalex', 'scholar', 'crossref'] },
    { id: 'chinese', label: '中文', on: ['baiduxueshu', 'cnki', 'scholar', 'openalex'] },
  ],
};
