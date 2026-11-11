import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resultCount, usableSources } from '../src/config';
import { fetchContents } from '../src/content';
import { parseCount } from '../src/engines/shared';
import { rednote, xiaohongshu } from '../src/engines/xiaohongshu';
import { zhihu } from '../src/engines/zhihu';
import { fuse } from '../src/fusion';
import { runSearch } from '../src/pipeline';
import { SEARCH_MODES, modeHasText } from '../src/types';
import type { Env, FusedResult, PipelineEvent, SearchHit } from '../src/types';
import { normalizeUrl } from '../src/url';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const dom = (html: string) => {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as ParentNode;
};
const ZHIHU_PAGE = 'https://www.zhihu.com/search?type=content&q=x';
const RN_PAGE = 'https://www.rednote.com/search_result?keyword=x';
const NOTE_ID = '6af44acb000000002c00ed7b';

describe('parseCount', () => {
  it('reads the number styles the platforms print', () => {
    expect(parseCount('赞同 423 ')).toBe(423);
    expect(parseCount('8,485')).toBe(8485);
    expect(parseCount('赞同 1.2 万')).toBe(12000);
    expect(parseCount('10万+')).toBe(100000);
    expect(parseCount('1.2K')).toBe(1200);
    expect(parseCount('105 条评论')).toBe(105);
  });
  it('returns nothing when there is no number', () => {
    expect(parseCount('赞同')).toBeUndefined();
    expect(parseCount('')).toBeUndefined();
    expect(parseCount(undefined)).toBeUndefined();
  });
});

describe('Zhihu engine (real captured page, see the fixture header)', () => {
  const hits = zhihu.extract(dom(fixture('zhihu.html')), ZHIHU_PAGE, 'zhihu');

  it('reads the result cards in order, one per link', () => {
    expect(hits.length).toBeGreaterThanOrEqual(8);
    expect(hits.map((hit) => hit.rank)).toEqual(hits.map((_, i) => i + 1));
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(hits.length);
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https:\/\/(www|zhuanlan)\.zhihu\.com\/(question\/\d+(\/answer\/\d+)?|p\/\d+)$/);
      expect(hit.title.length).toBeGreaterThan(0);
      expect(hit.snippet.length).toBeLessThanOrEqual(300);
      expect(hit.meta?.author ? hit.snippet.startsWith(hit.meta.author) : false).toBe(false);
    }
  });

  it('keeps an answer with its author, excerpt, votes, comments and date, without the highlight markup', () => {
    const answer = hits.find((hit) => hit.url.endsWith('/answer/2101105852715484425'));
    expect(answer).toMatchObject({
      url: 'https://www.zhihu.com/question/1999782884576358775/answer/2101105852715484425',
      title: '《红楼梦》有没有可能就不是曹雪芹写的，而是明朝宗室后裔的杰作？',
      host: 'zhihu.com',
      meta: { author: '永乐大帝明成祖', votes: 423, comments: 105, age: '11-04' },
    });
    expect(answer?.snippet).toMatch(/^我最推荐朱世巍先生对红楼梦的另类研究方法/);
    expect(answer?.content).toBe(answer?.snippet.replace(/…$/, '') ? answer?.content : undefined);
  });

  it('keeps an article with its cover and an absolute link', () => {
    const article = hits.find((hit) => hit.url === 'https://zhuanlan.zhihu.com/p/2009971748947380021');
    expect(article).toMatchObject({ title: '为什么《红楼梦》几乎没有宅斗，却比宫斗剧更残酷？', meta: { votes: 8485 } });
    expect(article?.meta?.thumbnail).toMatch(/^https:\/\/picx\.zhimg\.com\/80\//);
  });

  it('accepts question, answer and article links only, strips tracking, and skips cards without a link', () => {
    const card = (href: string, title = 'T') => `<div class="ContentItem"><h2 class="ContentItem-title"><a href="${href}">${title}</a></h2></div>`;
    const found = zhihu.extract(
      dom(
        card('/question/123/answer/456?utm_source=x') +
          card('/question/789', 'A question') +
          card('//zhuanlan.zhihu.com/p/42?from=search', 'An article') +
          card('/topic/19550517', 'A topic') +
          card('https://example.com/question/1', 'Elsewhere') +
          card('/question/123/answer/456', 'The same answer again') +
          '<div class="ContentItem"><h2 class="ContentItem-title">No link</h2></div>',
      ),
      ZHIHU_PAGE,
      'zhihu',
    );
    expect(found.map((hit) => hit.url)).toEqual([
      'https://www.zhihu.com/question/123/answer/456',
      'https://www.zhihu.com/question/789',
      'https://zhuanlan.zhihu.com/p/42',
    ]);
  });

  it('builds the search URL, is matched on the search page, and sees the sign-in page as a login wall (not a captcha)', () => {
    expect(zhihu.buildUrl('红楼梦', 10, 'zhihu')).toBe('https://www.zhihu.com/search?type=content&q=%E7%BA%A2%E6%A5%BC%E6%A2%A6');
    expect(zhihu.matches).toContain('*://www.zhihu.com/search*');
    expect(zhihu.isLoginUrl?.('https://www.zhihu.com/signin?next=%2Fsearch')).toBe(true);
    expect(zhihu.isLoginUrl?.(ZHIHU_PAGE)).toBe(false);
    expect(zhihu.isBlockedUrl?.('https://www.zhihu.com/signin?next=%2Fsearch')).toBe(false);
    expect(zhihu.isBlockedUrl?.('https://www.zhihu.com/account/unhuman?type=unhuman')).toBe(true);
    expect(dom(fixture('zhihu.html')).querySelector(zhihu.loginSelector!)).toBeNull();
    expect(dom(fixture('zhihu.html')).querySelector(zhihu.blockedSelector)).toBeNull();
    expect(dom(fixture('zhihu.html')).querySelector(zhihu.readySelector)).not.toBeNull();
  });

  it('keeps different answers to one question apart (they share a title but are not the same paper)', () => {
    const answer = (n: number, author: string): SearchHit => ({
      source: 'zhihu',
      url: `https://www.zhihu.com/question/1/answer/${n}`,
      title: '如何评价《红楼梦》中的贾政这个人物形象？',
      snippet: '',
      rank: n,
      meta: { author },
    });
    expect(fuse([[answer(1, 'a'), answer(2, 'b'), answer(3, 'c')]])).toHaveLength(3);
  });
});

describe('Xiaohongshu / RedNote engines (real captured page, see the fixture header)', () => {
  const hits = rednote.extract(dom(fixture('rednote.html')), RN_PAGE, 'xiaohongshu');

  it('reads every note in order with a cover, and skips the "related searches" module that reuses the card markup', () => {
    // The capture has 12 cards; the seventh is the "大家都在搜" suggestion strip, which has no note link.
    expect(hits).toHaveLength(11);
    expect(hits.some((hit) => hit.title.includes('大家都在搜'))).toBe(false);
    expect(hits.map((hit) => hit.rank)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https:\/\/www\.rednote\.com\/search_result\/[0-9a-f]{24}\?xsec_token=REDACTED/);
      expect(hit.title.length).toBeGreaterThan(0);
      expect(hit.note?.cover).toMatch(/^https:\/\/sns-webpic-qc\.xhscdn\.com\//);
      expect(hit.note?.width).toBeGreaterThan(0);
      expect(hit.note?.height).toBeGreaterThan(0);
    }
  });

  it('keeps title, author, time, likes and the cover size of a note', () => {
    expect(hits[0]).toMatchObject({
      host: 'rednote.com',
      title: '是这个门子坏吧，红楼梦',
      snippet: '',
      note: { author: '小坏、', time: '昨天 19:00', likes: '1', width: 4284, height: 5712 },
    });
    expect(hits[0].url.startsWith(`https://www.rednote.com/search_result/${NOTE_ID}?xsec_token=`)).toBe(true);
    expect(hits[0].note?.avatar).toMatch(/^https:\/\/sns-avatar-qc\.xhscdn\.com\//);
  });

  it('keeps only what opening a note needs: no tracking, no profile links, no duplicates', () => {
    const card = (href: string, title: string) =>
      `<section class="note-item" data-width="100" data-height="200"><a class="cover" href="${href}"></a><a class="title" href="${href}"><span>${title}</span></a></section>`;
    const found = xiaohongshu.extract(
      dom(
        card(`/search_result/${NOTE_ID}?xsec_token=T&xsec_source=pc_search&utm=x&channel_type=web`, 'With token') +
          card(`/search_result/${NOTE_ID}?xsec_token=T`, 'Same note') +
          card('/user/profile/65f8f1ac000000000600f0b9', 'A profile') +
          card('/search_result/abc', 'Not a note id') +
          card(`/search_result/${'0'.repeat(24)}`, '') +
          `<section class="note-item"><a class="cover" href="/search_result/${'1'.repeat(24)}"></a></section>`,
      ),
      'https://www.xiaohongshu.com/search_result?keyword=x',
      'xiaohongshu',
    );
    expect(found.map((hit) => hit.url)).toEqual([
      `https://www.xiaohongshu.com/search_result/${NOTE_ID}?xsec_token=T&xsec_source=pc_search`,
      `https://www.xiaohongshu.com/search_result/${'0'.repeat(24)}`,
      `https://www.xiaohongshu.com/search_result/${'1'.repeat(24)}`,
    ]);
    expect(found.map((hit) => hit.title)).toEqual(['With token', '无标题笔记', '无标题笔记']);
    expect(found[0].host).toBe('xiaohongshu.com');
  });

  it('builds the search URL for each site and is matched on its search page only', () => {
    const query = encodeURIComponent('红楼梦');
    expect(rednote.buildUrl('红楼梦', 12, 'xiaohongshu')).toBe(`https://www.rednote.com/search_result?keyword=${query}&source=web_search_result_notes`);
    expect(xiaohongshu.buildUrl('红楼梦', 12, 'xiaohongshu')).toBe(`https://www.xiaohongshu.com/search_result?keyword=${query}&source=web_search_result_notes`);
    expect(rednote.matches).toEqual(['*://www.rednote.com/search_result*', '*://www.rednote.com/website-login/*']);
    expect(xiaohongshu.matches).toEqual(['*://www.xiaohongshu.com/search_result*', '*://www.xiaohongshu.com/website-login/*']);
    expect(rednote.id).toBe('rednote');
    expect(xiaohongshu.id).toBe('xiaohongshu');
  });

  it('is ready on a card and does not mistake the real logged-in page for a login wall', () => {
    expect(dom(fixture('rednote.html')).querySelector(rednote.readySelector)).not.toBeNull();
    expect(dom(fixture('rednote.html')).querySelector(rednote.loginSelector!)).toBeNull();
    expect(dom(fixture('rednote.html')).querySelector(rednote.blockedSelector)).toBeNull();
  });

  it('merges the same note read from the two domains, and from any of its URL shapes', () => {
    const international = hits.map((hit): SearchHit => ({ ...hit, source: 'rednote' }));
    const mainland = xiaohongshu
      .extract(dom(fixture('rednote.html')), 'https://www.xiaohongshu.com/search_result?keyword=x', 'xiaohongshu')
      .map((hit): SearchHit => ({ ...hit, source: 'xiaohongshu' }));
    const fused = fuse([international, mainland]);
    expect(fused).toHaveLength(11);
    expect(fused.every((result) => result.sources.length === 2)).toBe(true);
    expect(fused[0].note?.author).toBe('小坏、');

    const key = `xhs:${NOTE_ID}`;
    for (const url of [
      `https://www.rednote.com/search_result/${NOTE_ID}?xsec_token=a&xsec_source=pc_search`,
      `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
      `https://www.xiaohongshu.com/discovery/item/${NOTE_ID.toUpperCase()}/`,
    ]) {
      expect(normalizeUrl(url)).toBe(key);
    }
    expect(normalizeUrl('https://www.rednote.com/user/profile/65f8f1ac000000000600f0b9')).toBe('rednote.com/user/profile/65f8f1ac000000000600f0b9');
  });
});

describe('Zhihu and Xiaohongshu modes', () => {
  function configFor(...enabled: string[]) {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = enabled.includes(id);
    config.llm.apiKey = '{{SECRET_llmkey01}}';
    return config;
  }
  const ids = (config = DEFAULT_CONFIG, mode: Parameters<typeof usableSources>[2], browser = true) =>
    usableSources(config, browser, mode).filter((source) => !source.reason).map((source) => source.id);

  it('adds the two modes, with text-style handling only for Zhihu', () => {
    expect(SEARCH_MODES).toEqual(['web', 'images', 'video', 'academic', 'zhihu', 'xiaohongshu', 'wechat', 'x']);
    expect(modeHasText('zhihu')).toBe(true);
    expect(modeHasText('xiaohongshu')).toBe(false);
    expect(resultCount(DEFAULT_CONFIG, 'xiaohongshu')).toBe(12);
    expect(resultCount(DEFAULT_CONFIG, 'zhihu')).toBe(10);
  });

  it('serves each mode from its own platform, with RedNote on by default and the mainland site opt-in', () => {
    expect(ids(DEFAULT_CONFIG, 'zhihu')).toEqual(['zhihu']);
    expect(ids(DEFAULT_CONFIG, 'xiaohongshu')).toEqual(['rednote']);
    const both = structuredClone(DEFAULT_CONFIG);
    both.sources.xiaohongshu = { enabled: true };
    expect(ids(both, 'xiaohongshu').sort()).toEqual(['rednote', 'xiaohongshu']);
    expect(ids(DEFAULT_CONFIG, 'web')).not.toEqual(expect.arrayContaining(['zhihu', 'rednote']));
    expect(ids(DEFAULT_CONFIG, 'xiaohongshu', false)).toEqual([]);
  });

  it('summarizes Zhihu answers from their excerpts without fetching the signed-in pages', async () => {
    const config = configFor('zhihu');
    config.summary.enabled = true;
    config.summary.contentFetcher = 'direct';
    const fetched: string[] = [];
    const env: Env = {
      fetch: async (input) => {
        if (input.endsWith('/chat/completions')) return new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n');
        fetched.push(input);
        throw new Error('must not fetch a signed-in page');
      },
      runBrowserEngine: async (engine, _query, opts) => {
        expect(opts.mode).toBe('zhihu');
        return [{ source: engine.id, url: 'https://www.zhihu.com/question/1/answer/2', title: 'Q', snippet: 'An excerpt', rank: 1, meta: { author: 'a', votes: 3 } }];
      },
    };
    const result = await runSearch('红楼梦', config, env, { mode: 'zhihu' });
    expect(result.summary).toBe('Answer');
    expect(result.citations).toHaveLength(1);
    expect(fetched).toEqual([]);
  });

  it('shows notes as they are: no judging, no summary', async () => {
    const config = configFor('rednote');
    config.summary.enabled = true;
    config.judge.apiKey = '{{SECRET_typesafe01}}';
    const asked: { engine: string; count: number }[] = [];
    const env: Env = {
      fetch: async () => {
        throw new Error('no network call expected for notes');
      },
      runBrowserEngine: async (engine, _query, opts) => {
        asked.push({ engine: engine.id, count: opts.count });
        return hitsOf(engine.id);
      },
    };
    const events: PipelineEvent[] = [];
    const result = await runSearch('红楼梦', config, env, { mode: 'xiaohongshu', onEvent: (event) => events.push(event) });
    expect(asked).toEqual([{ engine: 'rednote', count: 12 }]);
    expect(result.mode).toBe('xiaohongshu');
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.note)).toBe(true);
    const types = events.map((event) => event.type);
    expect(types).not.toContain('judged');
    expect(types.some((type) => type.startsWith('summary'))).toBe(false);

    function hitsOf(source: SearchHit['source']): SearchHit[] {
      return [1, 2].map((n) => ({ source, url: `https://www.rednote.com/search_result/${String(n).repeat(24)}`, title: `Note ${n}`, snippet: '', rank: n, note: { cover: 'https://sns-webpic-qc.xhscdn.com/x.webp' } }));
    }
  });

  it('never fetches a signed-in page for its text, and still fetches ordinary ones', async () => {
    const result = (url: string): FusedResult => ({ key: url, url, title: 't', snippet: 's', sources: [], rrfScore: 1, score: 1, meta: {} });
    const config = structuredClone(DEFAULT_CONFIG);
    config.summary.contentFetcher = 'direct';
    const fetched: string[] = [];
    const env: Env = {
      fetch: async (input) => {
        fetched.push(input);
        return new Response(`<html><body><p>${'Real page text. '.repeat(20)}</p></body></html>`, { headers: { 'Content-Type': 'text/html' } });
      },
    };
    const contents = await fetchContents(
      [result('https://www.zhihu.com/question/1/answer/2'), result('https://zhuanlan.zhihu.com/p/3'), result('https://www.rednote.com/search_result/' + '1'.repeat(24)), result('https://example.com/page')],
      config,
      env,
    );
    expect(fetched).toEqual(['https://example.com/page']);
    expect([...contents.keys()]).toEqual(['https://example.com/page']);
  });
});
