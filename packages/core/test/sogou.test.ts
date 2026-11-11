import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resultCount, usableSources } from '../src/config';
import { fetchContents } from '../src/content';
import { sogou, weixin } from '../src/engines/sogou';
import { fuse } from '../src/fusion';
import { runSearch } from '../src/pipeline';
import { SEARCH_MODES, modeHasText } from '../src/types';
import type { Env, FusedResult, SearchHit } from '../src/types';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const dom = (html: string) => {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as ParentNode;
};
const WEIXIN_PAGE = 'https://weixin.sogou.com/weixin?type=2&query=x';
const WEB_PAGE = 'https://www.sogou.com/web?query=x';

describe('Sogou WeChat engine (real captured page, see the fixture header)', () => {
  const hits = weixin.extract(dom(fixture('weixin.html')), WEIXIN_PAGE, 'wechat');

  it('reads every article card in order, each with a Sogou link that opens the article', () => {
    expect(hits).toHaveLength(10);
    expect(hits.map((hit) => hit.rank)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(10);
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https:\/\/weixin\.sogou\.com\/link\?url=[\w-]+.*token=REDACTED/);
      expect(hit.host).toBe('mp.weixin.qq.com');
      expect(hit.title.length).toBeGreaterThan(0);
      expect(hit.snippet.length).toBeLessThanOrEqual(300);
      expect(hit.meta?.author?.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(hit.publishedAt ?? ''))).toBe(false);
    }
  });

  it('keeps title, excerpt, account, thumbnail and the exact publish time of an article', () => {
    expect(hits[0]).toMatchObject({
      title: '《红楼梦》里的唯美诗词',
      publishedAt: '2016-03-08T13:54:29.000Z',
      meta: { author: '灼见', siteName: '微信公众号' },
    });
    expect(hits[0].snippet).toMatch(/^♫ 红楼梦全版主题歌曲音乐会完整视频/);
    expect(hits[0].url.startsWith('https://weixin.sogou.com/link?url=dn9a_-gY295K0Rci_xozVXfdMkSQTLW6')).toBe(true);
    expect(hits[0].meta?.thumbnail).toMatch(/^https:\/\/img01\.sogoucdn\.com\/v2\/thumb/);
    expect(hits.slice(1, 3).map((hit) => hit.meta?.author)).toEqual(['读者', '央视新闻']);
  });

  it('reads the publish time from the script text without running it, and copes with missing parts', () => {
    const card = (inner: string) => `<ul class="news-list"><li>${inner}</li></ul>`;
    const found = weixin.extract(
      dom(
        card('<div class="txt-box"><h3><a href="/link?url=aaa">No date, no account</a></h3></div>') +
          card('<div class="txt-box"><h3><a href="/link?url=aaa">Same link again</a></h3></div>') +
          card('<div class="txt-box"><h3><a href="/link?url=bbb">With account link</a></h3><p class="txt-info">A <em>hit</em></p></div><div class="s-p"><a class="account">某号</a><span class="s2"><script>document.write(timeConvert(\'1700000000\'))</script></span></div>') +
          card('<div class="txt-box"><h3>No link</h3></div>'),
      ),
      WEIXIN_PAGE,
      'wechat',
    );
    expect(found.map((hit) => hit.title)).toEqual(['No date, no account', 'With account link']);
    expect(found[0]).toMatchObject({ publishedAt: undefined, meta: { author: undefined } });
    expect(found[1]).toMatchObject({ snippet: 'A hit', publishedAt: '2023-11-14T22:13:20.000Z', meta: { author: '某号' } });
    expect(found[1].url).toBe('https://weixin.sogou.com/link?url=bbb');
  });

  it('builds the search URL, is matched on its pages, is ready on a card, and does not mistake the real page for a captcha', () => {
    expect(weixin.buildUrl('红楼梦', 10, 'wechat')).toBe(
      'https://weixin.sogou.com/weixin?type=2&query=%E7%BA%A2%E6%A5%BC%E6%A2%A6&ie=utf8&s_from=input&_sug_=n&_sug_type_=',
    );
    expect(weixin.matches).toContain('*://weixin.sogou.com/weixin*');
    expect(dom(fixture('weixin.html')).querySelector(weixin.readySelector)).not.toBeNull();
    expect(dom(fixture('weixin.html')).querySelector(weixin.blockedSelector)).toBeNull();
    expect(weixin.isBlockedUrl?.('https://weixin.sogou.com/antispider/?from=%2Fweixin')).toBe(true);
    expect(weixin.isBlockedUrl?.(WEIXIN_PAGE)).toBe(false);
  });
});

describe('Sogou web engine (real captured page, see the fixture header)', () => {
  const hits = sogou.extract(dom(fixture('sogou.html')), WEB_PAGE, 'web');

  it('reads the results in order, one per link, and drops jumps into Sogou\'s own pages', () => {
    expect(hits.length).toBeGreaterThanOrEqual(5);
    expect(hits.map((hit) => hit.rank)).toEqual(hits.map((_, i) => i + 1));
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(hits.length);
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https?:\/\//);
      expect(hit.title.length).toBeGreaterThan(0);
      expect(hit.snippet.length).toBeLessThanOrEqual(300);
      expect(hit.url.startsWith('https://www.sogou.com/sogou?')).toBe(false);
    }
  });

  it('keeps a redirect link as it is and takes the site from the card, and reads a vertical card with its own link', () => {
    const organic = hits.find((hit) => hit.title === '《红楼梦》小说原文全集在线阅读');
    expect(organic).toMatchObject({ host: 'hongloumeng.5000yan.com' });
    expect(organic?.url.startsWith('https://www.sogou.com/link?url=NdaMVEDuTuVqe9LRSQ8aQ7tRRsz03wtPyeFLi9sSVd4')).toBe(true);
    expect(organic?.snippet).toMatch(/^《红楼梦》以错综复杂的清代上层贵族社会为背景/);
    const baike = hits.find((hit) => hit.title.includes('搜狗百科'));
    expect(baike?.url.startsWith('https://baike.sogou.com/v19357.htm')).toBe(true);
    expect(baike?.host).toBe('baike.sogou.com');
  });

  it('handles odd cards: no site known for a bare redirect, repeats, cards without a title or link', () => {
    const card = (inner: string) => `<div class="vrwrap">${inner}</div>`;
    const found = sogou.extract(
      dom(
        card('<h3><a href="/link?url=aaa">Bare redirect</a></h3><div class="fz-mid space-txt">text</div>') +
          card('<h3><a href="/link?url=aaa">Same again</a></h3>') +
          card('<h3><a href="https://example.com/page">Direct</a></h3><p class="star-wiki">wiki text</p>') +
          card('<h3><a href="/sogou?query=related">Related searches</a></h3>') +
          card('<h3>No link</h3>') +
          card('<h3><a href="/link?url=bbb"></a></h3>'),
      ),
      WEB_PAGE,
      'web',
    );
    expect(found.map((hit) => [hit.title, hit.host, hit.snippet])).toEqual([
      ['Bare redirect', undefined, 'text'],
      ['Direct', 'example.com', 'wiki text'],
    ]);
  });

  it('builds the search URL and is ready on a result title', () => {
    expect(sogou.buildUrl('红楼梦', 10, 'web')).toBe('https://www.sogou.com/web?query=%E7%BA%A2%E6%A5%BC%E6%A2%A6');
    expect(sogou.matches).toContain('*://www.sogou.com/web*');
    expect(dom(fixture('sogou.html')).querySelector(sogou.readySelector)).not.toBeNull();
    expect(dom(fixture('sogou.html')).querySelector(sogou.blockedSelector)).toBeNull();
  });
});

describe('the WeChat mode', () => {
  function configFor(...enabled: string[]) {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = enabled.includes(id);
    config.llm.apiKey = '{{SECRET_llmkey01}}';
    return config;
  }
  const result = (url: string): FusedResult => ({ key: url, url, title: 't', snippet: 's', sources: [], rrfScore: 1, score: 1, meta: {} });

  it('is a text mode served by the WeChat search, while Sogou web stays out of the general search until switched on', () => {
    expect(SEARCH_MODES).toContain('wechat');
    expect(modeHasText('wechat')).toBe(true);
    expect(resultCount(DEFAULT_CONFIG, 'wechat')).toBe(10);
    const ids = (config: typeof DEFAULT_CONFIG, mode: Parameters<typeof usableSources>[2]) =>
      usableSources(config, true, mode).filter((source) => !source.reason).map((source) => source.id);
    expect(ids(DEFAULT_CONFIG, 'wechat')).toEqual(['weixin']);
    expect(ids(DEFAULT_CONFIG, 'web')).not.toContain('sogou');
    const on = structuredClone(DEFAULT_CONFIG);
    on.sources.sogou = { enabled: true };
    expect(ids(on, 'web')).toContain('sogou');
    expect(ids(on, 'wechat')).toEqual(['weixin']);
  });

  it('searches and summarizes from the excerpts, without fetching Sogou\'s redirect pages', async () => {
    const config = configFor('weixin');
    config.summary.enabled = true;
    config.summary.contentFetcher = 'direct';
    const fetched: string[] = [];
    const env: Env = {
      fetch: async (input) => {
        if (input.endsWith('/chat/completions')) return new Response('data: {"choices":[{"delta":{"content":"Answer"}}]}\n\ndata: [DONE]\n\n');
        fetched.push(input);
        throw new Error('must not fetch');
      },
      runBrowserEngine: async (engine, _query, opts) => {
        expect(opts).toMatchObject({ mode: 'wechat', count: 10 });
        const hit: SearchHit = { source: engine.id, url: 'https://weixin.sogou.com/link?url=abc', host: 'mp.weixin.qq.com', title: 'An article', snippet: 'An excerpt', rank: 1, meta: { author: '某号' } };
        return [hit];
      },
    };
    const searched = await runSearch('红楼梦', config, env, { mode: 'wechat' });
    expect(searched.summary).toBe('Answer');
    expect(fetched).toEqual([]);
  });

  it('does not fetch Sogou pages for their text, and still fetches ordinary ones', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.summary.contentFetcher = 'direct';
    const fetched: string[] = [];
    const env: Env = {
      fetch: async (input) => {
        fetched.push(input);
        return new Response(`<html><body><p>${'Real page text. '.repeat(20)}</p></body></html>`, { headers: { 'Content-Type': 'text/html' } });
      },
    };
    await fetchContents([result('https://weixin.sogou.com/link?url=a'), result('https://www.sogou.com/link?url=b'), result('https://example.com/page')], config, env);
    expect(fetched).toEqual(['https://example.com/page']);
  });

  it('keeps two Sogou redirect links to different articles apart', () => {
    const hit = (n: number): SearchHit => ({ source: 'weixin', url: `https://weixin.sogou.com/link?url=${n}&type=2&query=q&token=t${n}`, title: `Article ${n}`, snippet: '', rank: n });
    expect(fuse([[hit(1), hit(2)]])).toHaveLength(2);
  });
});
