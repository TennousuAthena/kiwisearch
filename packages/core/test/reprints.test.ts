import { describe, expect, it } from 'vitest';
import { foldReprints, fuse, mergeLateHits } from '../src/fusion';
import type { FusedResult, SearchHit } from '../src/types';

const ARTICLE = '我们从家庭伦理的角度重新阅读贾政这个形象，他既有迂腐刻板的一面，也有作为父亲的复杂情感，这一点常被忽略。';
const OTHER = '今天的天气很好我们去公园散步顺便拍了很多照片还遇到了一些朋友一起吃了午饭然后回家休息看了一部电影。';

const hit = (source: SearchHit['source'], url: string, title: string, snippet: string, rank: number, extra: Partial<SearchHit> = {}): SearchHit => ({ source, url, title, snippet, rank, ...extra });
const hostOf = (r: FusedResult) => new URL(r.url).hostname;
const result = (url: string, title: string, snippet: string, extra: Partial<FusedResult> = {}): FusedResult => ({ key: url, url, host: new URL(url).hostname, title, snippet, sources: [], rrfScore: 1, score: 1, meta: {}, ...extra });

describe('foldReprints', () => {
  it('folds the same article posted on several sites into one, keeping the copy that is not on a republishing site', () => {
    const list = [
      result('https://blog.csdn.net/x/article/1', '贾政的“正”与“迂”：读红楼梦的另一种角度_CSDN博客', ARTICLE, { rrfScore: 0.03 }),
      result('https://mp.weixin.qq.com/s/abc', '贾政的“正”与“迂”：读红楼梦的另一种角度', ARTICLE, { rrfScore: 0.02 }),
      result('https://example.org/other', '一篇完全不同的文章标题要足够长才行', OTHER, { rrfScore: 0.01 }),
    ];
    const out = foldReprints(list);
    expect(out.map((r) => r.host)).toEqual(['mp.weixin.qq.com', 'example.org']);
    expect(out[0].reprints).toEqual([{ url: 'https://blog.csdn.net/x/article/1', host: 'blog.csdn.net' }]);
    expect(out[0].rrfScore).toBe(0.03); // it takes the best rank of the family
  });

  it('between two ordinary sites, prefers the earlier date, then the better rank', () => {
    const dated = [
      result('https://a.example/p', '同一篇文章的标题足够长了吧', ARTICLE, { publishedAt: '2026-03-02' }),
      result('https://b.example/p', '同一篇文章的标题足够长了吧', ARTICLE, { publishedAt: '2026-01-15' }),
    ];
    expect(foldReprints(dated).map((r) => r.host)).toEqual(['b.example']);
    const undated = [result('https://a.example/p', '同一篇文章的标题足够长了吧', ARTICLE), result('https://b.example/p', '同一篇文章的标题足够长了吧', ARTICLE)];
    expect(foldReprints(undated).map((r) => r.host)).toEqual(['a.example']);
  });

  it('keeps apart two posts that only share a title', () => {
    const list = [result('https://a.example/p', '为什么程序员容易秃头的原因分析', ARTICLE), result('https://b.example/p', '为什么程序员容易秃头的原因分析', OTHER)];
    expect(foldReprints(list)).toEqual(list);
  });

  it('does not fold on a short or empty text, a short title, the same site, papers, or media', () => {
    const short = [result('https://a.example/p', '同一篇文章的标题足够长了吧', '太短'), result('https://b.example/p', '同一篇文章的标题足够长了吧', '太短')];
    expect(foldReprints(short)).toEqual(short);
    const title = [result('https://a.example/p', '短标题', ARTICLE), result('https://b.example/p', '短标题', ARTICLE)];
    expect(foldReprints(title)).toEqual(title);
    const sameSite = [result('https://a.example/1', '同一篇文章的标题足够长了吧', ARTICLE), result('https://a.example/2', '同一篇文章的标题足够长了吧', ARTICLE)];
    expect(foldReprints(sameSite)).toEqual(sameSite);
    const papers = [result('https://a.example/p', '同一篇文章的标题足够长了吧', ARTICLE, { meta: { year: 2020 } }), result('https://b.example/p', '同一篇文章的标题足够长了吧', ARTICLE, { meta: { year: 2020 } })];
    expect(foldReprints(papers)).toEqual(papers);
    const notes = [result('https://a.example/p', '同一篇文章的标题足够长了吧', ARTICLE, { note: {} as FusedResult['note'] }), result('https://b.example/p', '同一篇文章的标题足够长了吧', ARTICLE)];
    expect(foldReprints(notes)).toEqual(notes);
  });

  it('returns the same list when there is nothing to fold', () => {
    const list = [result('https://a.example/p', '一个足够长的标题放在这里', ARTICLE)];
    expect(foldReprints(list)).toBe(list);
  });
});

describe('fusion folds reprints', () => {
  it('fuses engine lists, then folds the copies', () => {
    const results = fuse([
      [hit('google', 'https://blog.csdn.net/x/1', '贾政的“正”与“迂”：读红楼梦的另一种角度_CSDN博客', ARTICLE, 1), hit('google', 'https://example.org/other', '一篇完全不同的文章标题要足够长才行', OTHER, 2)],
      [hit('bing', 'https://mp.weixin.qq.com/s/abc', '贾政的“正”与“迂”：读红楼梦的另一种角度', ARTICLE, 1)],
    ]);
    expect(results.map(hostOf)).toEqual(['mp.weixin.qq.com', 'example.org']);
    expect(results[0].reprints?.map((r) => r.host)).toEqual(['blog.csdn.net']);
    expect(results[0].score).toBe(1);
  });

  it('folds a late copy into the result that is already there', () => {
    const first = fuse([[hit('google', 'https://mp.weixin.qq.com/s/abc', '贾政的“正”与“迂”：读红楼梦的另一种角度', ARTICLE, 1)]]);
    const merged = mergeLateHits(first, [hit('baidu', 'https://blog.csdn.net/x/1', '贾政的“正”与“迂”：读红楼梦的另一种角度_CSDN博客', ARTICLE, 1)]);
    expect(merged).toHaveLength(1);
    expect(hostOf(merged[0])).toBe('mp.weixin.qq.com');
    expect(merged[0].reprints?.[0].host).toBe('blog.csdn.net');
  });
});
