import { describe, expect, it } from 'vitest';
import { applyRerank, fuse, normalizeUrl } from '../src';
import type { SearchHit } from '../src';

const hit = (source: SearchHit['source'], url: string, rank: number, snippet = ''): SearchHit => ({
  source,
  url,
  rank,
  title: url,
  snippet,
});

describe('normalizeUrl', () => {
  it('drops tracking params, www, trailing slash and fragments', () => {
    expect(normalizeUrl('https://www.example.com/a/?utm_source=x&b=2&a=1#frag')).toBe('example.com/a?a=1&b=2');
    expect(normalizeUrl('http://example.com/a')).toBe(normalizeUrl('https://example.com/a/'));
  });
  it('collapses arXiv and DOI variants', () => {
    expect(normalizeUrl('https://arxiv.org/abs/2401.01234v2')).toBe('arxiv:2401.01234');
    expect(normalizeUrl('https://arxiv.org/pdf/2401.01234.pdf')).toBe('arxiv:2401.01234');
    expect(normalizeUrl('https://doi.org/10.1145/ABC')).toBe('doi:10.1145/abc');
  });
});

describe('fuse (RRF)', () => {
  it('rewards documents found by several engines', () => {
    const fused = fuse([
      [hit('google', 'https://a.com', 1), hit('google', 'https://b.com', 2)],
      [hit('bing', 'https://www.b.com/', 1, 'longer snippet'), hit('bing', 'https://c.com', 2)],
    ]);
    expect(fused[0].key).toBe('b.com');
    expect(fused[0].sources.map((s) => s.source)).toEqual(['google', 'bing']);
    expect(fused[0].snippet).toBe('longer snippet');
    expect(fused).toHaveLength(3);
    expect(fused[0].score).toBe(1);
  });
  it('applies per-source weights', () => {
    const fused = fuse([[hit('google', 'https://a.com', 1)], [hit('openalex', 'https://b.com', 1)]], { openalex: 2 });
    expect(fused[0].key).toBe('b.com');
  });
});

describe('applyRerank', () => {
  it('orders mostly by reranker score', () => {
    const fused = fuse([[hit('google', 'https://a.com', 1), hit('google', 'https://b.com', 2)]]);
    const out = applyRerank(fused, new Map([['a.com', 0.1], ['b.com', 0.9]]));
    expect(out[0].key).toBe('b.com');
    expect(out[0].rerankScore).toBe(0.9);
  });
});
