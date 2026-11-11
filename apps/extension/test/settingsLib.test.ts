import { DEFAULT_CONFIG, type FusionConfig, type PipelineEvent } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import { addDomains, normalizeDomain, parseDomains } from '../lib/domains';
import { ageLabel, healthFromEvent } from '../lib/sourceHealth';
import { describeSource } from '../lib/sourceView';

const NOW = 1_000_000_000_000;
const config = (patch: Partial<FusionConfig['sources']>): FusionConfig => ({ ...structuredClone(DEFAULT_CONFIG), sources: { ...structuredClone(DEFAULT_CONFIG).sources, ...patch } });

describe('healthFromEvent', () => {
  it('maps what a search saw to a state per source', () => {
    const at = (event: PipelineEvent) => healthFromEvent(event, NOW);
    expect(at({ type: 'source_blocked', source: 'zhihu', message: '', reason: 'login' })).toEqual({ source: 'zhihu', health: { state: 'login', at: NOW } });
    expect(at({ type: 'source_blocked', source: 'google', message: '', reason: 'captcha' })?.health.state).toBe('captcha');
    expect(at({ type: 'source_done', source: 'bing', count: 7, ms: 1 })?.health).toEqual({ state: 'ok', at: NOW, count: 7 });
    expect(at({ type: 'source_done', source: 'bing', count: 0, ms: 1 })?.health.state).toBe('empty');
    expect(at({ type: 'late_results', source: 'google', results: [] })?.health.state).toBe('ok');
    expect(at({ type: 'source_error', source: 'brave', error: 'HTTP 401', ms: 1 })?.health).toMatchObject({ state: 'error', message: 'HTTP 401' });
    expect(at({ type: 'summary_done', text: '' })).toBeNull();
  });

  it('tells how long ago in plain words', () => {
    expect(ageLabel(NOW - 20_000, NOW)).toBe('刚刚');
    expect(ageLabel(NOW - 5 * 60_000, NOW)).toBe('5 分钟前');
    expect(ageLabel(NOW - 3 * 3_600_000, NOW)).toBe('3 小时前');
    expect(ageLabel(NOW - 2 * 86_400_000, NOW)).toBe('2 天前');
  });
});

describe('describeSource', () => {
  it('shows nothing for a source that is switched off', () => {
    expect(describeSource('yandex', config({}))).toBeNull();
  });

  it('asks for the key a source cannot run without, before anything else', () => {
    const badge = describeSource('brave', config({ brave: { enabled: true } }), { state: 'ok', at: NOW, count: 3 }, NOW);
    expect(badge).toMatchObject({ tone: 'warn', label: '需要 API Key', action: 'key' });
    expect(describeSource('brave', config({ brave: { enabled: true, apiKey: 'k' } }), undefined, NOW)).toMatchObject({ label: '已就绪' });
  });

  it('asks for the address of a SearXNG server', () => {
    expect(describeSource('searxng', config({ searxng: { enabled: true } }))).toMatchObject({ label: '需要填写地址' });
  });

  it('turns the last run into a status with something to do about it', () => {
    const c = config({ zhihu: { enabled: true }, google: { enabled: true } });
    expect(describeSource('zhihu', c, { state: 'login', at: NOW - 60_000 }, NOW)).toMatchObject({ tone: 'warn', label: '需要登录', action: 'login' });
    expect(describeSource('google', c, { state: 'captcha', at: NOW }, NOW)).toMatchObject({ label: '遇到验证码', action: 'verify' });
    expect(describeSource('google', c, { state: 'error', at: NOW, message: 'timeout' }, NOW)).toMatchObject({ tone: 'bad', hint: 'timeout' });
    expect(describeSource('google', c, { state: 'ok', at: NOW - 120_000, count: 9 }, NOW)).toMatchObject({ tone: 'ok', label: '可用', hint: '2 分钟前 · 9 条' });
  });

  it('tells a platform that needs a login from one that does not, before any search', () => {
    const c = config({ zhihu: { enabled: true }, google: { enabled: true } });
    expect(describeSource('zhihu', c)).toMatchObject({ label: '还没试过', action: 'login' });
    expect(describeSource('google', c)).toMatchObject({ label: '已就绪' });
  });
});

describe('domains', () => {
  it('reduces what people paste to a bare host name', () => {
    expect(normalizeDomain('https://www.CSDN.net/article/1?x=2')).toBe('csdn.net');
    expect(normalizeDomain('*.zhihu.com')).toBe('zhihu.com');
    expect(normalizeDomain('blog.example.org:8080/path')).toBe('blog.example.org');
    expect(normalizeDomain('例子.中国')).toBe('例子.中国');
    expect(normalizeDomain('not a host')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
  });

  it('splits a pasted list, drops repeats and reports what it could not read', () => {
    expect(parseDomains('a.com, www.a.com\nb.org  c')).toEqual({ domains: ['a.com', 'b.org'], rejected: ['c'] });
  });

  it('adds to an existing list without repeating', () => {
    expect(addDomains(['a.com'], 'a.com b.com')).toEqual({ list: ['a.com', 'b.com'], rejected: [] });
  });
});
