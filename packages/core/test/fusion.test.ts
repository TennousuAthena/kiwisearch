import { describe, expect, it } from 'vitest';
import { applyRerank, fuse, mergeLateHits, normalizeUrl } from '../src';
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
  it('shares a key between doi.org and publisher pages that embed the DOI', () => {
    const doi = normalizeUrl('https://doi.org/10.1007/s11263-015-0816-y');
    expect(normalizeUrl('https://link.springer.com/article/10.1007/s11263-015-0816-y')).toBe(doi);
    expect(normalizeUrl('https://onlinelibrary.wiley.com/doi/full/10.1002/ABC.123/pdf')).toBe('doi:10.1002/abc.123');
    expect(normalizeUrl('https://dl.acm.org/doi/10.1145/3292500.3330701?utm_source=x')).toBe('doi:10.1145/3292500.3330701');
    expect(normalizeUrl('https://example.com/blog/post')).toBe('example.com/blog/post');
  });
  it('keeps old-style arXiv ids intact', () => {
    expect(normalizeUrl('https://arxiv.org/abs/hep-th/9901001v3')).toBe('arxiv:hep-th/9901001');
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

describe('paper de-duplication', () => {
  const paper = (source: SearchHit['source'], url: string, rank: number, title: string, year?: number): SearchHit => ({
    ...hit(source, url, rank),
    title,
    meta: { authors: ['A. Author'], year },
  });
  const title = 'Attention Is All You Need: Transformers for Sequence Modeling';

  it('merges the same paper from different URLs when the title and year agree', () => {
    const fused = fuse([
      [paper('openalex', 'https://doi.org/10.1000/xyz', 1, title, 2017)],
      [paper('scholar', 'https://publisher.example/articles/12345', 2, title.toUpperCase() + '.', 2017)],
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0].sources.map((source) => source.source).sort()).toEqual(['openalex', 'scholar']);
  });

  it('keeps papers apart when the years differ or the title is short', () => {
    expect(
      fuse([[paper('openalex', 'https://a.example/1', 1, title, 2017)], [paper('scholar', 'https://b.example/2', 1, title, 2021)]]),
    ).toHaveLength(2);
    expect(
      fuse([[paper('openalex', 'https://a.example/1', 1, 'Introduction', 2017)], [paper('scholar', 'https://b.example/2', 1, 'Introduction', 2017)]]),
    ).toHaveLength(2);
  });

  it('does not merge plain web pages that happen to share a long title', () => {
    expect(
      fuse([[hit('google', 'https://a.example/1', 1)], [hit('bing', 'https://b.example/2', 1)]].map((list) =>
        list.map((item) => ({ ...item, title: title })),
      )),
    ).toHaveLength(2);
  });

  it('takes the larger citation count and fills missing metadata from the twin', () => {
    const left = paper('openalex', 'https://doi.org/10.1000/xyz', 1, title, 2017);
    left.meta = { ...left.meta, citations: 10, venue: undefined };
    const right = paper('scholar', 'https://publisher.example/a', 1, title, 2017);
    right.meta = { ...right.meta, citations: 90, venue: 'NeurIPS' };
    const [merged] = fuse([[left], [right]]);
    expect(merged.meta).toMatchObject({ citations: 90, venue: 'NeurIPS' });
  });

  it('folds a late paper into the existing result instead of appending it', () => {
    const initial = fuse([[paper('openalex', 'https://doi.org/10.1000/xyz', 1, title, 2017)]]);
    const merged = mergeLateHits(initial, [paper('scholar', 'https://publisher.example/a', 1, title, 2017)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources.map((source) => source.source)).toEqual(['openalex', 'scholar']);
  });
});

describe('mergeLateHits', () => {
  it('adds a late source badge to a matching wrapper result without changing order or score', () => {
    const wrapper = fuse([[
      {
        ...hit('google', 'https://www.google.com/goto?url=opaque', 1),
        host: 'example.com',
        title: 'Example page: a detailed guide to fusion ranking',
      },
    ]]);
    const originalScore = wrapper[0].score;
    const merged = mergeLateHits(wrapper, [
      {
        ...hit('bing', 'https://www.example.com/fusion', 2),
        title: 'Example page: a detailed guide to fusion ranking',
      },
    ]);
    expect(merged).not.toBe(wrapper);
    expect(merged[0].url).toBe(wrapper[0].url);
    expect(merged[0].sources.map((source) => source.source)).toEqual(['google', 'bing']);
    expect(merged[0].rrfScore).toBeCloseTo(wrapper[0].rrfScore + 1 / 62);
    expect(merged[0].score).toBe(originalScore);
    expect(merged[0].late).toBeUndefined();
  });

  it('appends unmatched hits at the end with zero score and a late marker', () => {
    const initial = fuse([[hit('google', 'https://example.com/first', 1)]]);
    const appended = mergeLateHits(initial, [hit('bing', 'https://example.com/second', 1)]);
    expect(appended.map((result) => result.url)).toEqual([
      'https://example.com/first',
      'https://example.com/second',
    ]);
    expect(appended[1]).toMatchObject({ late: true, score: 0 });
  });

  it('deduplicates late hits among themselves', () => {
    const appended = mergeLateHits([], [
      hit('bing', 'https://example.com/shared', 1),
      hit('baidu', 'https://www.example.com/shared/', 2),
    ]);
    expect(appended).toHaveLength(1);
    expect(appended[0].sources.map((source) => source.source)).toEqual(['bing', 'baidu']);
    expect(appended[0].late).toBe(true);
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
