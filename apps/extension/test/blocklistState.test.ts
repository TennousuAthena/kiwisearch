import { parseBlocklist } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import {
  REFRESH_AFTER_MS,
  RETRY_AFTER_MS,
  UPDATING_STALE_MS,
  blocklistStatus,
  describeCustomRules,
  downloadList,
  formatAgo,
  isDue,
  metaAfterDownload,
  readTextLimited,
  subscriptionsChanged,
  type BlocklistMeta,
  type FetchFn,
} from '../lib/blocklistState';

const URL_A = 'https://lists.example.com/a.txt';
const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

/** A 304 has no body, and `Response` refuses to be built with one. */
const reply = (body: string, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(init.status === 304 ? null : body, { status: init.status ?? 200, headers: init.headers });

/** A fake network that answers every request the same way and records them. */
function network(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return answer();
  };
  return { fetchFn, calls };
}

describe('downloadList', () => {
  it('asks without cookies or referrer, and returns the text with its etag', async () => {
    const net = network(() => reply('a.example.com\n', { headers: { etag: '"v1"' } }));
    const got = await downloadList(net.fetchFn, URL_A);
    expect(got).toEqual({ kind: 'text', text: 'a.example.com\n', etag: '"v1"' });
    expect(net.calls[0].url).toBe(URL_A);
    expect(net.calls[0].init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    expect(net.calls[0].init?.headers).toBeUndefined();
  });

  it('sends the etag of what is kept, and understands "not modified"', async () => {
    const net = network(() => reply('', { status: 304 }));
    expect(await downloadList(net.fetchFn, URL_A, '"v1"')).toEqual({ kind: 'not-modified' });
    expect(net.calls[0].init?.headers).toEqual({ 'If-None-Match': '"v1"' });
  });

  it('says what went wrong in words the settings page can show', async () => {
    await expect(downloadList(network(() => reply('nope', { status: 404 })).fetchFn, URL_A)).rejects.toThrow('服务器返回 HTTP 404');
    const offline: FetchFn = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(downloadList(offline, URL_A)).rejects.toThrow(/连不上/);
    const hung: FetchFn = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    await expect(downloadList(hung, URL_A, undefined, 20)).rejects.toThrow(/没有响应/);
  });

  it('refuses a list that is too big, whether or not the host says so up front', async () => {
    await expect(readTextLimited(reply('x'.repeat(100), { headers: { 'content-length': '5000' } }), 1000)).rejects.toThrow(/超过/);
    await expect(readTextLimited(reply('x'.repeat(5000)), 1000)).rejects.toThrow(/超过/);
    expect(await readTextLimited(reply('x'.repeat(900)), 1000)).toHaveLength(900);
  });

  it('reads text in pieces without breaking a multi-byte character at a boundary', async () => {
    const bytes = new TextEncoder().encode('例子.cn  #内容农场\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2)); // inside the first character
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });
    expect(await readTextLimited(new Response(stream))).toBe('例子.cn  #内容农场\n');
  });
});

describe('isDue', () => {
  const kept: BlocklistMeta = { url: URL_A, fetchedAt: NOW - HOUR, attemptedAt: NOW - HOUR, rules: 10 };

  it('is due when nothing is known, or the address changed', () => {
    expect(isDue(undefined, { url: URL_A }, NOW)).toBe(true);
    expect(isDue(kept, { url: 'https://lists.example.com/b.txt' }, NOW)).toBe(true);
  });

  it('waits a day after a good fetch, and an hour after a failed one', () => {
    expect(isDue(kept, { url: URL_A }, NOW)).toBe(false);
    expect(isDue({ ...kept, attemptedAt: NOW - REFRESH_AFTER_MS }, { url: URL_A }, NOW)).toBe(true);
    const failed = { ...kept, error: 'HTTP 500', attemptedAt: NOW - RETRY_AFTER_MS / 2 };
    expect(isDue(failed, { url: URL_A }, NOW)).toBe(false);
    expect(isDue({ ...failed, attemptedAt: NOW - RETRY_AFTER_MS }, { url: URL_A }, NOW)).toBe(true);
  });

  it('leaves a list that is being downloaded alone, unless the worker that started it must have died', () => {
    expect(isDue({ url: URL_A, updatingSince: NOW - 1000 }, { url: URL_A }, NOW)).toBe(false);
    expect(isDue({ url: URL_A, updatingSince: NOW - UPDATING_STALE_MS - 1 }, { url: URL_A }, NOW)).toBe(true);
  });
});

describe('what the settings page says', () => {
  const parsed = parseBlocklist(['a.example.com', 'b.example.com', '||c.example.com^$script', 'd.example.com##.ad'].join('\n'));

  it('words the state of a subscribed list', () => {
    expect(blocklistStatus(undefined, NOW)).toEqual({ tone: 'neutral', text: '等待下载' });
    expect(blocklistStatus({ url: URL_A, updatingSince: NOW - 500 }, NOW)).toEqual({ tone: 'neutral', text: '正在下载…' });
    const ok = metaAfterDownload(URL_A, parsed, undefined, NOW - 3 * HOUR);
    expect(blocklistStatus(ok, NOW)).toEqual({ tone: 'ok', text: '2 条规则，3 小时前更新，1 行写法不支持，已跳过' });
    expect(blocklistStatus({ ...ok, error: '服务器返回 HTTP 500' }, NOW)).toEqual({
      tone: 'bad',
      text: '这次更新失败：服务器返回 HTTP 500。仍在用之前的版本（2 条规则，3 小时前更新）',
    });
    expect(blocklistStatus({ url: URL_A, error: '连不上这个地址' }, NOW)).toEqual({ tone: 'bad', text: '下载失败：连不上这个地址' });
  });

  it('tells how long ago in the largest sensible unit', () => {
    expect(formatAgo(NOW - 20_000, NOW)).toBe('刚刚');
    expect(formatAgo(NOW - 5 * 60_000, NOW)).toBe('5 分钟前');
    expect(formatAgo(NOW - 5 * HOUR, NOW)).toBe('5 小时前');
    expect(formatAgo(NOW - 72 * HOUR, NOW)).toBe('3 天前');
  });

  it('sums up the user\'s own rules: what counted and what was left out', () => {
    expect(describeCustomRules(parseBlocklist('').stats)).toBe('');
    expect(describeCustomRules(parsed.stats)).toBe('2 条规则有效；1 行没有用上（例如 “||c.example.com^$script”）；1 行是页面元素规则，不适用于搜索结果');
  });
});

describe('subscriptionsChanged', () => {
  const stored = (lists: object) => ({ version: 5, judge: { blocklists: { recommended: [], subscriptions: [], custom: '', ...lists } } });
  const sub = (id: string, enabled = true, url = `https://lists.example.com/${id}.txt`) => ({ id, name: id, url, enabled });

  it('says yes when a list is switched on, added, re-addressed, switched off or removed', () => {
    expect(subscriptionsChanged({ oldValue: stored({}), newValue: stored({ recommended: ['content-farm-terminator'] }) })).toBe(true);
    expect(subscriptionsChanged({ oldValue: stored({}), newValue: stored({ subscriptions: [sub('a')] }) })).toBe(true);
    expect(subscriptionsChanged({ oldValue: stored({ subscriptions: [sub('a')] }), newValue: stored({ subscriptions: [sub('a', true, 'https://lists.example.com/other.txt')] }) })).toBe(true);
    expect(subscriptionsChanged({ oldValue: stored({ subscriptions: [sub('a')] }), newValue: stored({ subscriptions: [sub('a', false)] }) })).toBe(true);
    // Removing one that was already switched off still leaves its stored rules to be forgotten.
    expect(subscriptionsChanged({ oldValue: stored({ subscriptions: [sub('a', false)] }), newValue: stored({}) })).toBe(true);
  });

  it('says no for anything else: the user\'s own rules, other settings, no change, a config that was never stored', () => {
    expect(subscriptionsChanged({ oldValue: stored({ custom: 'a.example.com' }), newValue: stored({ custom: 'b.example.com' }) })).toBe(false);
    expect(subscriptionsChanged({ oldValue: stored({ subscriptions: [sub('a')] }), newValue: { ...stored({ subscriptions: [sub('a')] }), perSourceCount: 3 } })).toBe(false);
    expect(subscriptionsChanged({ oldValue: undefined, newValue: undefined })).toBe(false);
    expect(subscriptionsChanged(undefined)).toBe(false);
    expect(subscriptionsChanged({ oldValue: undefined, newValue: stored({ subscriptions: [sub('a')] }) })).toBe(true);
  });
});
