// The browser academic sources. What is real and what is not (see docs/PLAN.md "known gaps" for the long form):
//   REAL captures:  baiduxueshu.html (all 10 cards), baiduxueshu-blocked.html, cnki-blocked.html, wos-blocked.html (scripts removed,
//                   captcha key/token and client IP redacted).
//   HAND-WRITTEN:   cnki.html and wos.html (a captcha and a login stand in front of the real result pages); the tests on those only
//                   prove the parsers match the markup they were written against.
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, usableSources } from '../src/config';
import { BROWSER_ENGINES } from '../src/engines';
import { baiduxueshu } from '../src/engines/baiduxueshu';
import { cnki } from '../src/engines/cnki';
import { wos } from '../src/engines/wos';
import { SOURCES } from '../src/sources';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const dom = (html: string) => {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as ParentNode;
};


describe('Baidu Scholar engine (real captures)', () => {
  const page = 'https://xueshu.baidu.com/ndscholar/browse/search?wd=%E6%B7%B1%E5%BA%A6%E5%AD%A6%E4%B9%A0';
  const hits = baiduxueshu.extract(dom(fixture('baiduxueshu.html')), page, 'academic');

  it('reads the ten cards in order, each linked to its Baidu Scholar detail page', () => {
    expect(hits).toHaveLength(10);
    expect(hits.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(hits.map((h) => h.url)).size).toBe(10);
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https:\/\/xueshu\.baidu\.com\/usercenter\/paper\/show\?paperid=[0-9a-z]{32}/);
      expect(hit.title.length).toBeGreaterThan(1);
      expect(hit.content?.length).toBeGreaterThan(10);
      expect(hit.meta?.year).toBeGreaterThan(1990);
      expect(hit.meta?.citations).toBeGreaterThanOrEqual(0);
    }
  });

  it('splits the byline row into authors, journal, citations and year', () => {
    expect(hits[0]).toMatchObject({
      title: '深度学习研究进展',
      meta: { authors: ['刘建伟', '刘媛', '罗雄麟'], venue: '计算机应用研究', year: 2014, citations: 681 },
    });
    expect(hits[0].content).toMatch(/^鉴于深度学习的重要性/);
    expect(hits[0].snippet).toMatch(/^期刊 · 刘建伟, 刘媛, 罗雄麟 · 计算机应用研究 · 2014 — 鉴于/);
    // Two authors in one link, separated by an ASCII comma.
    expect(hits[1].meta?.authors).toEqual(['何玲', '黎加厚']);
    // A book has a publisher where a journal would be, and no source list.
    expect(hits[9]).toMatchObject({ meta: { authors: ['詹森', 'LeAnnNickelsen'], venue: '华东师范大学出版社', year: 2010, citations: 44 } });
  });

  it('prints no DOI in the list, so none is invented', () => {
    expect(hits.some((h) => h.meta?.doi)).toBe(false);
  });

  it('is ready on the results and not blocked there, and the cold-load captcha is recognized by its library files', () => {
    expect(dom(fixture('baiduxueshu.html')).querySelector(baiduxueshu.readySelector)).not.toBeNull();
    expect(dom(fixture('baiduxueshu.html')).querySelector(baiduxueshu.blockedSelector)).toBeNull();
    const captcha = dom(fixture('baiduxueshu-blocked.html'));
    expect(captcha.querySelector(baiduxueshu.blockedSelector)).not.toBeNull();
    expect(captcha.querySelector(baiduxueshu.readySelector)).toBeNull();
    expect(baiduxueshu.extract(captcha, 'https://xueshu.baidu.com/s?wd=x', 'academic')).toEqual([]);
  });

  it('builds the search address and is matched on both the address it opens and the one it settles on', () => {
    expect(baiduxueshu.buildUrl('深度学习 & 图', 10, 'academic')).toMatch(/^https:\/\/xueshu\.baidu\.com\/s\?wd=%E6%B7%B1%E5%BA%A6%E5%AD%A6%E4%B9%A0%20%26%20%E5%9B%BE&/);
    expect(baiduxueshu.matches).toEqual(expect.arrayContaining(['*://xueshu.baidu.com/s*', '*://xueshu.baidu.com/ndscholar/*']));
    expect(baiduxueshu.isBlockedUrl?.('https://wappass.baidu.com/static/captcha/tuxing.html')).toBe(true);
    expect(baiduxueshu.isBlockedUrl?.(page)).toBe(false);
  });
});

describe('CNKI engine (captcha page real; result table hand-written, UNVERIFIED)', () => {
  const page = 'https://kns.cnki.net/kns8s/defaultresult/index?korder=SU&kw=x';
  const hits = cnki.extract(dom(fixture('cnki.html')), page, 'academic');

  it('reads one hit per table row and skips nothing it can read', () => {
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.rank)).toEqual([1, 2, 3]);
    expect(hits[0]).toMatchObject({
      url: 'https://kns.cnki.net/kcms2/article/abstract?v=EXAMPLE-TOKEN-1&uniplatform=NZKPT&language=CHS',
      title: '基于深度学习的文本分类方法研究',
      publishedAt: '2021-05-12',
      meta: { authors: ['张三', '李四', '王五', '赵六'], venue: '示例学报', year: 2021, citations: 1234 },
    });
    expect(hits[0].snippet).toBe('期刊 · 张三, 李四, 王五 等 · 示例学报 · 2021');
  });

  it('copes with plain-text authors, a missing citation count, a relative link, a year-only date and an abstract', () => {
    expect(hits[1].meta).toMatchObject({ authors: ['孙七', '周八'], venue: '示例大学', year: 2019 });
    expect(hits[1].meta?.citations).toBeUndefined();
    expect(hits[2].url).toBe('https://kns.cnki.net/kcms2/article/abstract?v=EXAMPLE-TOKEN-3&uniplatform=NZKPT&language=CHS');
    expect(hits[2].publishedAt).toBeUndefined();
    expect(hits[2].meta?.year).toBe(2022);
    expect(hits[2].content).toBe('本文综述了图神经网络的发展脉络与主要模型。');
  });

  it("recognizes CNKI's real slider-captcha page by address and by its markup", () => {
    // The address CNKI really redirected the search to.
    expect(cnki.isBlockedUrl?.('https://kns.cnki.net/verify/home?captchaType=blockPuzzle&ident=d3624d&captchaId=c1a637e3&returnUrl=x')).toBe(true);
    expect(cnki.isBlockedUrl?.('https://kns.cnki.net/kns8s/defaultresult/index?kw=x')).toBe(false);
    const captcha = dom(fixture('cnki-blocked.html'));
    expect(captcha.querySelector(cnki.blockedSelector)).not.toBeNull();
    expect(captcha.querySelector(cnki.readySelector)).toBeNull();
    expect(dom(fixture('cnki.html')).querySelector(cnki.blockedSelector)).toBeNull();
    expect(dom(fixture('cnki.html')).querySelector(cnki.readySelector)).not.toBeNull();
    expect(cnki.matches).toContain('*://kns.cnki.net/verify/*');
  });

  it('builds the kns8s search address', () => {
    expect(cnki.buildUrl('深度学习', 10, 'academic')).toBe('https://kns.cnki.net/kns8s/defaultresult/index?korder=SU&kw=%E6%B7%B1%E5%BA%A6%E5%AD%A6%E4%B9%A0');
  });
});

describe('Web of Science engine (sign-in page real; record cards hand-written, UNVERIFIED)', () => {
  const page = 'https://www.webofscience.com/wos/woscc/general-summary?query=TS%3D(x)';
  const hits = wos.extract(dom(fixture('wos.html')), page, 'academic');

  it('reads the record cards that have a title link and skips one that has none', () => {
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      url: 'https://www.webofscience.com/wos/woscc/full-record/WOS:000000000000001',
      title: 'An Example Study of Graph Neural Networks',
      content: 'We study an invented thing and report invented results.',
      meta: { authors: ['Doe, J.', 'Roe, R.', 'Poe, P.', 'Moe, M.'], venue: 'JOURNAL OF EXAMPLE RESEARCH', year: 2021, citations: 1234 },
    });
  });

  it('still returns the title and link when the data-ta attributes are not there', () => {
    expect(hits[1]).toMatchObject({ url: 'https://www.webofscience.com/wos/woscc/full-record/WOS:000000000000002', title: 'A Second Invented Paper', meta: { authors: ['Lee, K.'], year: 2019 } });
    const bare = wos.extract(dom('<app-record><a href="/wos/woscc/full-record/WOS:1">Only a link</a></app-record>'), page, 'academic');
    expect(bare).toMatchObject([{ url: 'https://www.webofscience.com/wos/woscc/full-record/WOS:1', title: 'Only a link', meta: {} }]);
  });

  it('reports blocked on the real Clarivate sign-in page the app sends a user with no access to', () => {
    // The address the signed-out search was really redirected to (query string shortened).
    expect(wos.isBlockedUrl?.('https://access.clarivate.com/login?app=wos&alternative=true&goto=https:%2F%2Fwww.webofknowledge.com&roaming=true')).toBe(true);
    expect(wos.isBlockedUrl?.(page)).toBe(false);
    const login = dom(fixture('wos-blocked.html'));
    expect(login.querySelector(wos.blockedSelector)).not.toBeNull();
    expect(login.querySelector(wos.readySelector)).toBeNull();
    // Without the sign-in host in `matches` the content script never runs there and the source would only time out.
    expect(wos.matches).toEqual(expect.arrayContaining(['*://www.webofscience.com/wos/*', '*://access.clarivate.com/login*']));
    expect(dom(fixture('wos.html')).querySelector(wos.blockedSelector)).toBeNull();
    expect(dom(fixture('wos.html')).querySelector(wos.readySelector)).not.toBeNull();
  });

  it('builds a Topic search address', () => {
    expect(wos.buildUrl('graph neural network', 10, 'academic')).toBe('https://www.webofscience.com/wos/woscc/general-summary?query=TS%3D(graph%20neural%20network)');
  });
});

describe('the three browser academic sources as registered', () => {
  const ids = ['baiduxueshu', 'cnki', 'wos'] as const;

  it('serve the academic mode only, need no key, and run in the browser', () => {
    for (const id of ids) {
      expect(SOURCES[id].modes).toEqual(['academic']);
      expect(SOURCES[id].requiresKey).toBe(false);
      expect(SOURCES[id].requiresBrowser).toBe(true);
      expect(BROWSER_ENGINES[id].id).toBe(id);
    }
  });

  it('are off by default, and when switched on still wait for a browser', () => {
    const reasons = (config: typeof DEFAULT_CONFIG, hasBrowser: boolean) =>
      Object.fromEntries(
        usableSources(config, hasBrowser, 'academic')
          .filter((s) => (ids as readonly string[]).includes(s.id))
          .map((s) => [s.id, s.reason ?? 'on']),
      );
    expect(reasons(DEFAULT_CONFIG, true)).toEqual({ baiduxueshu: 'disabled', cnki: 'disabled', wos: 'disabled' });
    const config = structuredClone(DEFAULT_CONFIG);
    for (const id of ids) config.sources[id] = { enabled: true };
    expect(reasons(config, true)).toEqual({ baiduxueshu: 'on', cnki: 'on', wos: 'on' });
    expect(reasons(config, false)).toEqual({ baiduxueshu: 'needs browser extension', cnki: 'needs browser extension', wos: 'needs browser extension' });
  });
});
