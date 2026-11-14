import { describe, expect, it } from 'vitest';
import { hideUnresolvedLinks, isUnresolvedLink } from '../src/links';
import type { FusedResult } from '../src/types';

const GOTO = 'https://www.google.com/goto?url=opaque';
const result = (url: string, patch: Partial<FusedResult> = {}): FusedResult => ({
  key: url,
  url,
  title: url,
  snippet: '',
  sources: [{ source: 'google', rank: 1 }],
  rrfScore: 1,
  score: 1,
  meta: {},
  ...patch,
});
const wrapper = (n: number, patch: Partial<FusedResult> = {}) => result(`${GOTO}-${n}`, patch);
const direct = (n: number, patch: Partial<FusedResult> = {}) => result(`https://site${n}.example/page`, patch);

describe('isUnresolvedLink', () => {
  it('is a Google /goto link, whatever the Google domain', () => {
    expect(isUnresolvedLink({ url: GOTO })).toBe(true);
    expect(isUnresolvedLink({ url: 'https://www.google.com.hk/goto?url=opaque' })).toBe(true);
  });

  it('is not a page, another Google address or something that only looks like it', () => {
    expect(isUnresolvedLink({ url: 'https://example.com/page' })).toBe(false);
    expect(isUnresolvedLink({ url: 'https://www.google.com/search?q=x' })).toBe(false);
    expect(isUnresolvedLink({ url: 'https://www.google.com/goto' })).toBe(false);
    expect(isUnresolvedLink({ url: 'https://example.com/goto?url=opaque' })).toBe(false);
    expect(isUnresolvedLink({ url: 'http://www.google.com/goto?url=opaque' })).toBe(false);
    expect(isUnresolvedLink({ url: 'not an address' })).toBe(false);
  });
});

describe('hideUnresolvedLinks', () => {
  it('hides the links and says why, and leaves every other result as it was', () => {
    const list = [direct(1), wrapper(1), direct(2), wrapper(2), direct(3)];
    const out = hideUnresolvedLinks(list, 3);
    expect(out.filter((r) => r.hidden).map((r) => r.url)).toEqual([`${GOTO}-1`, `${GOTO}-2`]);
    expect(out.filter((r) => r.hidden).every((r) => r.hidden?.reason === 'unresolved')).toBe(true);
    for (const kept of out.filter((r) => !r.hidden)) expect(kept).toBe(list.find((r) => r.url === kept.url));
    // The input is not changed.
    expect(list.every((r) => !r.hidden)).toBe(true);
  });

  it('puts the visible results first and keeps the order inside each group', () => {
    const out = hideUnresolvedLinks([wrapper(1), direct(1), wrapper(2), direct(2), direct(3)], 3);
    expect(out.map((r) => r.url)).toEqual(['https://site1.example/page', 'https://site2.example/page', 'https://site3.example/page', `${GOTO}-1`, `${GOTO}-2`]);
  });

  it('hides them when exactly the minimum of other results stays visible, and not when one is short', () => {
    expect(hideUnresolvedLinks([direct(1), direct(2), direct(3), wrapper(1)], 3).filter((r) => r.hidden)).toHaveLength(1);
    const short = [direct(1), direct(2), wrapper(1), wrapper(2)];
    expect(hideUnresolvedLinks(short, 3)).toBe(short);
  });

  it('leaves them where they are when the page would be empty: a search whose only source is Google', () => {
    const onlyGoogle = [wrapper(1), wrapper(2), wrapper(3), wrapper(4)];
    const out = hideUnresolvedLinks(onlyGoogle, 3);
    expect(out).toBe(onlyGoogle);
    expect(out.some((r) => r.hidden)).toBe(false);
  });

  it('does not count what is already hidden as a result that stays, and keeps the reason it has', () => {
    const blockedLink = wrapper(9, { hidden: { reason: 'blocked', list: 'A list' } });
    const list = [direct(1, { hidden: { reason: 'junk' } }), direct(2), direct(3), blockedLink, wrapper(1)];
    // Only two others are visible (one is hidden as junk), so the link stays.
    expect(hideUnresolvedLinks(list, 3)).toBe(list);
    const enough = [...list, direct(4)];
    const out = hideUnresolvedLinks(enough, 3);
    expect(out.find((r) => r.url === `${GOTO}-1`)?.hidden).toEqual({ reason: 'unresolved' });
    expect(out.find((r) => r.url === blockedLink.url)?.hidden).toEqual({ reason: 'blocked', list: 'A list' });
    expect(out.find((r) => r.url === 'https://site1.example/page')?.hidden).toEqual({ reason: 'junk' });
  });

  it('returns the very same list when there is no such link', () => {
    const list = [direct(1), direct(2), direct(3)];
    expect(hideUnresolvedLinks(list, 3)).toBe(list);
    expect(hideUnresolvedLinks([], 3)).toEqual([]);
  });
});
