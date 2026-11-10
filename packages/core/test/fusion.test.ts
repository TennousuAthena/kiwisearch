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
  it('drops Bing msockid parameters regardless of case', () => {
    const bare = 'https://www.mongodb.com/resources/basics/reciprocal-rank-fusion';
    expect(normalizeUrl(`${bare}?msockid=095abedf12345678`)).toBe(normalizeUrl(bare));
    expect(normalizeUrl(`${bare}?MSOCKID=095abedf12345678`)).toBe(normalizeUrl(bare));
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

  it('merges a hosted Google wrapper into a same-page result with a matching title', () => {
    const wrapper: SearchHit = {
      ...hit('google', 'https://www.google.com/goto?url=opaque', 2),
      host: 'www.mongodb.com',
      title: 'MongoDB Atlas Search: Retrieval — Guide… - MongoDB',
    };
    const bing: SearchHit = {
      ...hit('bing', 'https://mongodb.com/resources/atlas-search', 1),
      title: 'MongoDB Atlas Search Retrieval Guide Overview | MongoDB',
    };
    const results = fuse([[wrapper], [bing]], { google: 2, bing: 3 });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe(bing.url);
    expect(results[0].sources.map((source) => source.source).sort()).toEqual(['bing', 'google']);
    expect(results[0].rrfScore).toBeCloseTo(2 / 62 + 3 / 61);
  });

  it('keeps same-host results with different titles separate', () => {
    const wrapper: SearchHit = {
      ...hit('google', 'https://www.google.com/goto?url=opaque', 1),
      host: 'mongodb.com',
      title: 'Quarterly revenue forecast',
    };
    const other = hit('bing', 'https://www.mongodb.com/results', 1, 'MongoDB Atlas Search Guide');
    expect(fuse([[wrapper], [other]])).toHaveLength(2);
  });

  it('keeps a wrapper separate when it has no host', () => {
    const wrapper = hit('google', 'https://www.google.com/goto?url=opaque', 1);
    const other = hit('bing', 'https://www.mongodb.com/results', 1);
    other.title = wrapper.title;
    expect(fuse([[wrapper], [other]])).toHaveLength(2);
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
