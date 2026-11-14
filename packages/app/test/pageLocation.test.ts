import { describe, expect, it } from 'vitest';
import { readPageParams, writePageLocation } from '../src/lib/pageLocation';

const read = (search: string, hash: string) => Object.fromEntries(readPageParams({ search, hash }));

describe('reading an address', () => {
  it('reads the query-string form the extension page uses', () => {
    expect(read('?q=hello+world&m=news&range=7d', '')).toEqual({ q: 'hello world', m: 'news', range: '7d' });
    expect(read('', '')).toEqual({});
  });

  it('reads the fragment form: other parameters first, then q with the whole rest', () => {
    expect(read('', '#m=news&range=7d&q=hello%20world')).toEqual({ m: 'news', range: '7d', q: 'hello world' });
    expect(read('', '#q=hello%20world')).toEqual({ q: 'hello world' });
  });

  it('takes what a browser search box leaves unescaped in the fragment as part of the query (checked in Chromium 156)', () => {
    // The search text was "hello world&x=1#f 你好".
    expect(read('', '#q=hello%20world&x=1%23f%20%E4%BD%A0%E5%A5%BD')).toEqual({ q: 'hello world&x=1#f 你好' });
    expect(read('', '#q=a&q=b&m=news')).toEqual({ q: 'a&q=b&m=news' });
    expect(read('', '#q=m=news&x')).toEqual({ q: 'm=news&x' });
  });

  it('treats a plus in the fragment as a plus and keeps a stray percent sign', () => {
    // %2B %2B is two plus signs, the third plus is typed as it is: all three stay.
    expect(read('', '#q=c%2B%2B+and+more')).toEqual({ q: 'c+++and+more' });
    expect(read('', '#q=100%')).toEqual({ q: '100%' });
    expect(read('', '#q=%E4%BD')).toEqual({ q: '%E4%BD' });
  });

  it('lets the fragment win over the query string', () => {
    expect(read('?q=old&m=images', '#q=new')).toEqual({ q: 'new', m: 'images' });
  });

  it('reads an empty query and a fragment without q', () => {
    expect(read('', '#m=news')).toEqual({ m: 'news' });
    expect(read('', '#')).toEqual({});
  });
});

describe('writing an address', () => {
  const base = 'https://s.kiwi.moe/?old=1#old';

  it('writes the fragment form with q last and escaped', () => {
    expect(writePageLocation(base, 'hash', { query: 'a&b #c', mode: 'news', extra: { range: '7d' } })).toBe('https://s.kiwi.moe/#m=news&range=7d&q=a%26b%20%23c');
    expect(writePageLocation(base, 'hash', { query: 'hello', mode: 'web' })).toBe('https://s.kiwi.moe/#q=hello');
    expect(writePageLocation(base, 'hash', { query: '', mode: 'images' })).toBe('https://s.kiwi.moe/#m=images');
    expect(writePageLocation(base, 'hash', { query: '', mode: 'web' })).toBe('https://s.kiwi.moe/');
  });

  it('writes the query-string form for the extension page', () => {
    expect(writePageLocation('chrome-extension://x/newtab.html#old', 'search', { query: 'hello world', mode: 'academic', extra: { since: '2020' } })).toBe('chrome-extension://x/newtab.html?q=hello+world&m=academic&since=2020');
  });

  it('round-trips every query in both styles', () => {
    for (const query of ['hello', 'a&b=c', 'a&q=b', '100%', '50% off #1', 'c++ + python', '你好 世界', 'x=1&m=news', '?q=1', 'line\nbreak', '\u{1F600}']) {
      for (const style of ['search', 'hash'] as const) {
        const url = new URL(writePageLocation('https://s.kiwi.moe/', style, { query, mode: 'news', extra: { range: '7d' } }));
        expect(Object.fromEntries(readPageParams({ search: url.search, hash: url.hash })), `${style}: ${query}`).toEqual({ q: query, m: 'news', range: '7d' });
      }
    }
  });
});
