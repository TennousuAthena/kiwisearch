import type { SourceId } from '@kiwi-search/core';

/** Names for the settings page; search results deliberately don't show where they came from. */
export const SOURCE_LABELS: Record<SourceId, string> = {
  google: 'Google',
  bing: 'Bing',
  baidu: '百度',
  yandex: 'Yandex',
  duckduckgo: 'DuckDuckGo',
  scholar: 'Google Scholar',
  brave: 'Brave',
  exa: 'Exa',
  deepseek: 'DeepSeek',
  openalex: 'OpenAlex',
  arxiv: 'arXiv',
  crossref: 'Crossref',
  openverse: 'Openverse',
  youtube: 'YouTube',
  bilibili: '哔哩哔哩',
  zhihu: '知乎',
  xiaohongshu: '小红书（国内站）',
  rednote: 'RedNote（国际站）',
  sogou: '搜狗（网页）',
  weixin: '搜狗微信（公众号）',
  x: 'X（Twitter）',
  searxng: 'SearXNG',
};
