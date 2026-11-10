import type { SourceId } from '@fusion-search/core';
import { browser } from 'wxt/browser';

export const SOURCE_META: Record<SourceId, { label: string; short: string; color: string; kind: string }> = {
  google: { label: 'Google', short: 'G', color: '#4285f4', kind: 'Web（浏览器渲染）' },
  bing: { label: 'Bing', short: 'B', color: '#00809d', kind: 'Web' },
  baidu: { label: '百度', short: '百', color: '#2932e1', kind: 'Web（浏览器渲染）' },
  yandex: { label: 'Yandex', short: 'Y', color: '#fc3f1d', kind: 'Web（浏览器渲染）' },
  duckduckgo: { label: 'DuckDuckGo', short: 'D', color: '#de5833', kind: 'Web' },
  scholar: { label: 'Google Scholar', short: '学', color: '#4385f5', kind: '学术（浏览器渲染）' },
  brave: { label: 'Brave', short: 'Br', color: '#fb542b', kind: 'Web API' },
  exa: { label: 'Exa', short: 'E', color: '#1f40ed', kind: 'AI 语义检索' },
  deepseek: { label: 'DeepSeek', short: 'DS', color: '#4d6bfe', kind: 'AI 搜索 API' },
  openalex: { label: 'OpenAlex', short: 'OA', color: '#c0392b', kind: '学术' },
  searxng: { label: 'SearXNG', short: 'Sx', color: '#3050ff', kind: '自建元搜索' },
};

export function faviconUrl(pageUrl: string): string {
  const u = new URL(browser.runtime.getURL('/newtab.html'));
  u.pathname = '/_favicon/';
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '32');
  return u.toString();
}
