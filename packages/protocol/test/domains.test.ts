import { describe, expect, it } from 'vitest';
import { addDomains, normalizeDomain, parseDomains } from '../src';

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
