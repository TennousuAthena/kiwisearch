import type { FusedResult } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import {
  breadcrumb,
  compactCount,
  filterSince,
  formatDuration,
  COMMUNITY_MODES,
  MODES,
  isCommunityMode,
  hiddenLabel,
  iconHost,
  modeHasOverview,
  parseMode,
  pickLandmarks,
  platformOf,
  splitPlatforms,
  searchUrl,
  siteLabel,
  sinceYears,
  sortPapers,
  splitResults,
} from '../lib/results';

const paper = (title: string, meta: FusedResult['meta'], publishedAt?: string): FusedResult => ({
  key: title,
  url: `https://example.com/${title}`,
  title,
  snippet: '',
  sources: [],
  rrfScore: 1,
  score: 1,
  meta,
  publishedAt,
});

describe('result helpers', () => {
  it('splits visible from hidden results keeping order', () => {
    const list = [paper('a', {}), { ...paper('b', {}), hidden: { reason: 'junk' as const } }, paper('c', {})];
    const { visible, hidden } = splitResults(list);
    expect(visible.map((r) => r.title)).toEqual(['a', 'c']);
    expect(hidden.map((r) => r.title)).toEqual(['b']);
  });

  it('explains every hiding reason in plain words', () => {
    expect(hiddenLabel({ reason: 'junk' })).toMatch(/内容农场/);
    expect(hiddenLabel({ reason: 'irrelevant' })).toMatch(/关系不大/);
    expect(hiddenLabel({ reason: 'rule', rule: '搬运文' })).toContain('搬运文');
    expect(hiddenLabel({ reason: 'blocked' })).toMatch(/屏蔽/);
  });

  it('builds a Google-style address line', () => {
    expect(breadcrumb({ url: 'https://www.example.com/docs/guide/intro' })).toBe('example.com › docs › guide › intro');
    expect(breadcrumb({ url: 'https://example.com/a/b/c/d/e' })).toBe('example.com › a › b › c › …');
    expect(breadcrumb({ url: 'https://example.com/' })).toBe('example.com');
    expect(breadcrumb({ url: 'https://www.google.com/goto?url=x', host: 'blog.example.org' })).toBe('blog.example.org › goto');
    expect(breadcrumb({ url: 'not a url' })).toBe('not a url');
    expect(breadcrumb({ url: 'https://www.sogou.com/link?url=abc', host: 'hongloumeng.5000yan.com' })).toBe('hongloumeng.5000yan.com');
    expect(breadcrumb({ url: 'https://weixin.sogou.com/link?url=a&type=2', host: 'mp.weixin.qq.com' })).toBe('mp.weixin.qq.com');
  });

  it('picks the host whose icon heads a result: the stated host, else the full host of the link', () => {
    expect(iconHost({ url: 'https://www.sogou.com/link?url=x', host: 'mp.weixin.qq.com' })).toBe('mp.weixin.qq.com');
    expect(iconHost({ url: 'https://www.example.com/a' })).toBe('www.example.com');
    expect(iconHost({ url: 'not a url' })).toBe('');
  });

  it('derives a site label from the host', () => {
    expect(siteLabel({ url: 'https://docs.github.com/x', meta: {} })).toBe('GitHub');
    expect(siteLabel({ url: 'https://stackoverflow.com/questions/1', meta: {} })).toBe('Stack Overflow');
    expect(siteLabel({ url: 'https://zhuanlan.zhihu.com/p/1', meta: {} })).toBe('知乎');
    expect(siteLabel({ url: 'https://www.bbc.co.uk/news', meta: {} })).toBe('Bbc');
    expect(siteLabel({ url: 'https://blog.example.org/', meta: {} })).toBe('Example');
    expect(siteLabel({ url: 'https://localhost:3000/', meta: {} })).toBe('localhost');
    expect(siteLabel({ url: 'https://x.example/', meta: { siteName: '知乎' } })).toBe('知乎');
  });

  it('prints counts the way X does', () => {
    expect([0, 999, 1000, 1218, 16661, 123456, 999999, 5026349, 1.5e9].map(compactCount)).toEqual(['0', '999', '1K', '1.2K', '16.7K', '123K', '1M', '5M', '1.5B']);
  });

  it('formats durations', () => {
    expect(formatDuration(420)).toBe('0.42 秒');
    expect(formatDuration(2310)).toBe('2.3 秒');
  });

  it('offers Scholar-style since years and filters by them, dropping papers of unknown year', () => {
    expect(sinceYears(new Date('2026-11-11'))).toEqual([2026, 2025, 2022]);
    const list = [paper('new', { year: 2025 }), paper('old', { year: 2015 }), paper('unknown', {}), paper('dated', {}, '2024-03-01')];
    expect(filterSince(list, 2022).map((r) => r.title)).toEqual(['new', 'dated']);
    expect(filterSince(list)).toBe(list);
  });

  it('sorts papers by citations without mutating the input, unknown counts last', () => {
    const list = [paper('a', { citations: 5 }), paper('b', {}), paper('c', { citations: 50 })];
    expect(sortPapers(list, 'citations').map((r) => r.title)).toEqual(['c', 'a', 'b']);
    expect(list.map((r) => r.title)).toEqual(['a', 'b', 'c']);
    expect(sortPapers(list, 'relevance')).toBe(list);
  });

  it('lists the modes in tab order and knows which have an AI overview', () => {
    expect(MODES).toEqual(['web', 'images', 'video', 'academic', 'zhihu', 'xiaohongshu', 'wechat', 'x']);
    expect(MODES.filter(modeHasOverview)).toEqual(['web', 'academic', 'zhihu', 'wechat']);
  });

  it('names the video platforms from the result link, not from the search source', () => {
    expect(siteLabel({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', host: 'youtube.com', meta: {} })).toBe('YouTube');
    expect(siteLabel({ url: 'https://www.bilibili.com/video/BV1N2WT6tE1H/', host: 'bilibili.com', meta: {} })).toBe('哔哩哔哩');
  });

  it('round-trips the mode through the page URL, keeping web search URLs clean', () => {
    expect(parseMode('images')).toBe('images');
    expect(parseMode('academic')).toBe('academic');
    expect(parseMode('video')).toBe('video');
    expect(parseMode('zhihu')).toBe('zhihu');
    expect(parseMode('xiaohongshu')).toBe('xiaohongshu');
    expect(parseMode('wechat')).toBe('wechat');
    expect(parseMode('x')).toBe('x');
    expect(searchUrl('chrome-extension://abc/newtab.html', 'a', 'xiaohongshu')).toBe('chrome-extension://abc/newtab.html?q=a&m=xiaohongshu');
    expect(searchUrl('chrome-extension://abc/newtab.html', 'a', 'video')).toBe('chrome-extension://abc/newtab.html?q=a&m=video');
    expect(parseMode('bogus')).toBe('web');
    expect(parseMode(null)).toBe('web');
    expect(searchUrl('chrome-extension://abc/newtab.html?m=images', 'a b', 'web')).toBe('chrome-extension://abc/newtab.html?q=a+b');
    expect(searchUrl('chrome-extension://abc/newtab.html', 'a', 'academic')).toBe('chrome-extension://abc/newtab.html?q=a&m=academic');
  });
});

describe('pickLandmarks', () => {
  const list = [paper('Other paper on attention', { year: 2020 }), paper('Attention Is All You Need', { year: 2017, doi: '10.1/abc' }), paper('BERT: Pre-training', { year: 2018 })];
  it('finds the results that are the named papers, in the order they were named', () => {
    const picked = pickLandmarks(list, [{ title: 'BERT: Pre-training' }, { title: 'attention is all you need!', year: 2017 }]);
    expect(picked.map((r) => r.title)).toEqual(['BERT: Pre-training', 'Attention Is All You Need']);
  });

  it('prefers the DOI, skips a paper that is not in the list, and never picks one result twice', () => {
    expect(pickLandmarks(list, [{ title: 'Some other spelling', doi: '10.1/ABC' }]).map((r) => r.title)).toEqual(['Attention Is All You Need']);
    expect(pickLandmarks(list, [{ title: 'Not here at all' }])).toEqual([]);
    expect(pickLandmarks(list, [{ title: 'BERT: Pre-training' }, { title: 'BERT Pre-training' }])).toHaveLength(1);
  });
});

describe('community platforms in a general list', () => {
  const post = (title: string, meta: FusedResult['meta'] = {}, extra: Partial<FusedResult> = {}) => ({ ...paper(title, meta), ...extra });
  const zhihu = (n: number) => post(`z${n}`, { siteName: '知乎' });
  const wechat = (n: number) => post(`w${n}`, { siteName: '微信公众号' });
  const note = (n: number) => post(`n${n}`, {}, { note: { cover: 'x', width: 1, height: 1, author: 'a', time: 't', likes: '1' } as FusedResult['note'] });

  it('tells which platform a result is a post from', () => {
    expect(platformOf(zhihu(1))).toBe('zhihu');
    expect(platformOf(wechat(1))).toBe('wechat');
    expect(platformOf(note(1))).toBe('xiaohongshu');
    expect(platformOf(paper('web', {}))).toBeNull();
  });

  it('pulls two or more posts out of the list, leaving everything else where it was', () => {
    const list = [paper('a', {}), zhihu(1), paper('b', {}), note(1), paper('c', {})];
    const { platform, rest } = splitPlatforms(list);
    expect(platform.map((r) => r.title)).toEqual(['z1', 'n1']);
    expect(rest.map((r) => r.title)).toEqual(['a', 'b', 'c']);
  });

  it('leaves a lone post in the list', () => {
    const list = [paper('a', {}), zhihu(1), paper('b', {})];
    expect(splitPlatforms(list)).toEqual({ platform: [], rest: list });
  });

  it('lets no platform fill the block, and keeps what does not fit in the list', () => {
    const list = [zhihu(1), zhihu(2), zhihu(3), zhihu(4), wechat(1), note(1), note(2), note(3), note(4)];
    const { platform, rest } = splitPlatforms(list);
    expect(platform.map((r) => r.title)).toEqual(['z1', 'z2', 'z3', 'w1', 'n1', 'n2']);
    expect(rest.map((r) => r.title)).toEqual(['z4', 'n3', 'n4']);
  });
});

describe('tab structure', () => {
  it('folds the platforms into one tab and leaves the content types', () => {
    expect(MODES.filter((m) => !isCommunityMode(m))).toEqual(['web', 'images', 'video', 'academic']);
    expect(COMMUNITY_MODES).toEqual(['zhihu', 'xiaohongshu', 'wechat', 'x']);
    for (const mode of COMMUNITY_MODES) expect(MODES).toContain(mode);
  });
});
