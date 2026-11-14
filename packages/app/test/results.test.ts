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
  hasCjk,
  hiddenLabel,
  iconHost,
  modeHasOverview,
  decisionModelNotes,
  explainServiceError,
  parseMode,
  pickLandmarks,
  platformOf,
  splitPlatforms,
  searchUrl,
  siteLabel,
  sinceYears,
  sortPapers,
  splitResults,
} from '../src/lib/results';

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
    expect(hiddenLabel({ reason: 'blocked' })).toBe('来自你屏蔽的网站');
    expect(hiddenLabel({ reason: 'blocked', list: 'Content Farm Terminator' })).toBe('命中屏蔽列表“Content Farm Terminator”');
    expect(hiddenLabel({ reason: 'language' })).toBe('语言不符：当前只看英文文献');
    expect(hiddenLabel({ reason: 'unresolved' })).toBe('Google 跳转链接未能还原，点击仍可打开');
  });

  it('tells text with Chinese, Japanese or Korean characters from text without', () => {
    expect(hasCjk('深度学习 review')).toBe(true);
    expect(hasCjk('ディープラーニング')).toBe(true);
    expect(hasCjk('딥러닝')).toBe(true);
    expect(hasCjk('deep learning α-synuclein')).toBe(false);
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
    expect(MODES).toEqual(['web', 'images', 'video', 'news', 'shopping', 'academic', 'zhihu', 'xiaohongshu', 'wechat', 'x']);
    expect(MODES.filter(modeHasOverview)).toEqual(['web', 'news', 'academic', 'zhihu', 'wechat']);
  });

  it('names the video platforms from the result link, not from the search source', () => {
    expect(siteLabel({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', host: 'youtube.com', meta: {} })).toBe('YouTube');
    expect(siteLabel({ url: 'https://www.bilibili.com/video/BV1N2WT6tE1H/', host: 'bilibili.com', meta: {} })).toBe('哔哩哔哩');
    expect(siteLabel({ url: 'https://www.douyin.com/video/123', host: 'douyin.com', meta: {} })).toBe('抖音');
  });

  it('round-trips the mode through the page URL, keeping web search URLs clean', () => {
    expect(parseMode('shopping')).toBe('shopping');
    expect(searchUrl('chrome-extension://abc/newtab.html', '耳机', 'shopping')).toBe('chrome-extension://abc/newtab.html?q=%E8%80%B3%E6%9C%BA&m=shopping');
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

  it('names shopping platforms and retains the shopping tab with an empty query', () => {
    expect(siteLabel({ url: 'https://item.taobao.com/item.htm?id=123', meta: {} })).toBe('淘宝');
    expect(siteLabel({ url: 'https://detail.tmall.com/item.htm?id=123', meta: {} })).toBe('天猫');
    expect(siteLabel({ url: 'https://item.jd.com/123.html', meta: {} })).toBe('京东');
    expect(siteLabel({ url: 'https://www.amazon.com/dp/B012345678', meta: {} })).toBe('Amazon');
    expect(searchUrl('chrome-extension://abc/newtab.html?q=old&m=news&range=week&sort=date', '', 'shopping')).toBe('chrome-extension://abc/newtab.html?m=shopping');
    expect(isCommunityMode('shopping')).toBe(false);
    expect(modeHasOverview('shopping')).toBe(false);
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
    expect(MODES.filter((m) => !isCommunityMode(m))).toEqual(['web', 'images', 'video', 'news', 'shopping', 'academic']);
    expect(COMMUNITY_MODES).toEqual(['zhihu', 'xiaohongshu', 'wechat', 'x']);
    for (const mode of COMMUNITY_MODES) expect(MODES).toContain(mode);
  });
});

describe('explainServiceError', () => {
  it('turns what a person can act on into plain words, and leaves the rest alone', () => {
    expect(explainServiceError('HTTP 451: {"title":"Typesafe is not available in your region.","status":451}')).toMatch(/地区不可用.*代理分流/);
    expect(explainServiceError('HTTP 401: invalid key')).toMatch(/Key 无效.*401/);
    expect(explainServiceError('HTTP 403')).toMatch(/403/);
    expect(explainServiceError('HTTP 429: slow down')).toMatch(/限流/);
    expect(explainServiceError('超过 3000ms，只搜索通用来源')).toContain('超过 3000ms');
    expect(explainServiceError('something odd')).toBe('something odd');
  });
});

describe('decisionModelNotes', () => {
  const nope = 'HTTP 451: {"title":"Typesafe is not available in your region.","status":451}';

  it('says nothing when nothing went wrong', () => {
    expect(decisionModelNotes({ mode: 'web' })).toEqual([]);
  });

  it('puts one reason on one line when the same thing stopped both features', () => {
    const notes = decisionModelNotes({ mode: 'web', judgeError: nope, intentError: nope });
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toMatch(/^自动补搜、智能过滤未生效：.*HTTP 451/);
    expect(notes[0].title).toContain('Typesafe is not available');
  });

  it('keeps different reasons apart, and only blames the platform search in a general search', () => {
    expect(decisionModelNotes({ mode: 'web', judgeError: '超过 6000ms', intentError: nope }).map((n) => n.text)).toEqual([
      expect.stringMatching(/^自动补搜未生效：.*451/),
      '智能过滤未生效：超过 6000ms',
    ]);
    expect(decisionModelNotes({ mode: 'academic', judgeError: '超过 6000ms', intentError: nope }).map((n) => n.text)).toEqual(['智能过滤未生效：超过 6000ms']);
  });
});
