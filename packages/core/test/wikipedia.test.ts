import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config';
import { fuse, mergeLateHits } from '../src/fusion';
import { foldHan } from '../src/han';
import { runSearch } from '../src/pipeline';
import type { Env, FusedResult, SearchHit } from '../src/types';
import { foldWikipediaEditions, isChineseLanguage, parseWikipediaUrl, wikipediaFoldEnabled, wikipediaTarget, wikipediaTitleKey } from '../src/wikipedia';

const result = (url: string, title: string, extra: Partial<FusedResult> = {}): FusedResult => ({
  key: url,
  url,
  host: new URL(url).hostname,
  title,
  snippet: '',
  sources: [{ source: 'google', rank: 1 }],
  rrfScore: 1,
  score: 1,
  meta: {},
  ...extra,
});
const urls = (list: FusedResult[]) => list.map((r) => r.url);
const shown = (list: FusedResult[]) => list.map((r) => decodeURI(r.url));
const hit = (source: SearchHit['source'], url: string, title: string, rank: number): SearchHit => ({ source, url, title, snippet: '', rank });

describe('foldHan', () => {
  it('turns Traditional characters into Simplified ones and leaves the rest alone', () => {
    expect(foldHan('計算機')).toBe('计算机');
    expect(foldHan('周杰倫')).toBe('周杰伦');
    expect(foldHan('臺灣')).toBe('台湾');
    expect(foldHan('後')).toBe('后');
    expect(foldHan('髮')).toBe('发');
    expect(foldHan('裡')).toBe('里');
    expect(foldHan('裏')).toBe('里');
    expect(foldHan('龍馬 C++ Python 東京 ひらがな')).toBe('龙马 C++ Python 东京 ひらがな');
    expect(foldHan('计算机')).toBe('计算机');
    expect(foldHan('')).toBe('');
  });
});

describe('isChineseLanguage', () => {
  it('is true for every Chinese tag and false for the others', () => {
    for (const tag of ['zh', 'zh-CN', 'zh_TW', 'zh-Hant-HK', 'yue', 'yue-HK', 'wuu', 'lzh', 'zh-classical', 'zh-yue', 'nan', 'gan', 'hak', 'ZH-cn']) expect(isChineseLanguage(tag), tag).toBe(true);
    for (const tag of ['en', 'en-GB', 'ja', 'ko', 'fr-CA', '', undefined]) expect(isChineseLanguage(tag), String(tag)).toBe(false);
  });

  it('decides whether the fold is on: what the user chose, else Chinese browsers', () => {
    expect(wikipediaFoldEnabled(undefined, 'zh-CN')).toBe(true);
    expect(wikipediaFoldEnabled(undefined, 'en-US')).toBe(false);
    expect(wikipediaFoldEnabled(undefined, undefined)).toBe(false);
    expect(wikipediaFoldEnabled(false, 'zh-CN')).toBe(false);
    expect(wikipediaFoldEnabled(true, 'en-US')).toBe(true);
  });
});

describe('wikipediaTarget', () => {
  it('names the edition, and for Mandarin the variant, a browser language stands for', () => {
    expect(wikipediaTarget('zh-CN')).toEqual({ edition: 'zh', script: 'hans', variant: 'zh-cn' });
    expect(wikipediaTarget('zh-Hans')).toEqual({ edition: 'zh', script: 'hans', variant: 'zh-hans' });
    expect(wikipediaTarget('zh-TW')).toEqual({ edition: 'zh', script: 'hant', variant: 'zh-tw' });
    expect(wikipediaTarget('zh_HK')).toEqual({ edition: 'zh', script: 'hant', variant: 'zh-hk' });
    expect(wikipediaTarget('zh-Hant-TW')).toEqual({ edition: 'zh', script: 'hant', variant: 'zh-tw' });
    expect(wikipediaTarget('zh')).toEqual({ edition: 'zh' });
  });

  it('maps the other Chinese languages to the editions that carry them', () => {
    expect(wikipediaTarget('yue')).toEqual({ edition: 'zh-yue' });
    expect(wikipediaTarget('yue-HK')).toEqual({ edition: 'zh-yue' });
    expect(wikipediaTarget('zh-yue')).toEqual({ edition: 'zh-yue' });
    expect(wikipediaTarget('lzh')).toEqual({ edition: 'zh-classical' });
    expect(wikipediaTarget('zh-classical')).toEqual({ edition: 'zh-classical' });
    expect(wikipediaTarget('nan')).toEqual({ edition: 'zh-min-nan' });
    expect(wikipediaTarget('zh-min-nan')).toEqual({ edition: 'zh-min-nan' });
    for (const code of ['wuu', 'gan', 'hak', 'cdo']) expect(wikipediaTarget(code)).toEqual({ edition: code });
  });

  it('takes any other language as its own edition, and nothing when there is no language', () => {
    expect(wikipediaTarget('en-GB')).toEqual({ edition: 'en' });
    expect(wikipediaTarget('ja')).toEqual({ edition: 'ja' });
    expect(wikipediaTarget(undefined)).toBeUndefined();
    expect(wikipediaTarget('  ')).toBeUndefined();
  });
});

describe('parseWikipediaUrl', () => {
  it('reads the edition and the title of an article address', () => {
    expect(parseWikipediaUrl('https://en.wikipedia.org/wiki/Computer_science')).toEqual({ edition: 'en', title: 'Computer science' });
    expect(parseWikipediaUrl('https://zh.wikipedia.org/wiki/%E8%AE%A1%E7%AE%97%E6%9C%BA')).toEqual({ edition: 'zh', title: '计算机' });
    expect(parseWikipediaUrl('https://zh-yue.wikipedia.org/wiki/電腦')).toEqual({ edition: 'zh-yue', title: '電腦' });
    expect(parseWikipediaUrl('https://zh-classical.wikipedia.org/wiki/電腦')).toEqual({ edition: 'zh-classical', title: '電腦' });
    expect(parseWikipediaUrl('https://wuu.wikipedia.org/wiki/电脑')).toEqual({ edition: 'wuu', title: '电脑' });
    expect(parseWikipediaUrl('https://zh-min-nan.wikipedia.org/wiki/Tiān-náu')).toEqual({ edition: 'zh-min-nan', title: 'Tiān-náu' });
  });

  it('reads the variant from the path, the query string, or an old per-variant host', () => {
    expect(parseWikipediaUrl('https://zh.wikipedia.org/zh-tw/計算機')).toEqual({ edition: 'zh', variant: 'zh-tw', title: '計算機' });
    expect(parseWikipediaUrl('https://zh.wikipedia.org/zh-hans/计算机')).toEqual({ edition: 'zh', variant: 'zh-hans', title: '计算机' });
    expect(parseWikipediaUrl('https://zh.wikipedia.org/zh/计算机')).toEqual({ edition: 'zh', title: '计算机' });
    expect(parseWikipediaUrl('https://zh.wikipedia.org/wiki/计算机?variant=zh-hk')).toEqual({ edition: 'zh', variant: 'zh-hk', title: '计算机' });
    expect(parseWikipediaUrl('https://zh.wikipedia.org/w/index.php?title=计算机&variant=zh-sg')).toEqual({ edition: 'zh', variant: 'zh-sg', title: '计算机' });
    expect(parseWikipediaUrl('https://zh-tw.wikipedia.org/wiki/計算機')).toEqual({ edition: 'zh', variant: 'zh-tw', title: '計算機' });
  });

  it('reads the mobile host as the same edition, and ignores the fragment', () => {
    expect(parseWikipediaUrl('https://zh.m.wikipedia.org/wiki/计算机#历史')).toEqual({ edition: 'zh', title: '计算机' });
    expect(parseWikipediaUrl('https://en.m.wikipedia.org/wiki/Computer')).toEqual({ edition: 'en', title: 'Computer' });
  });

  it('is undefined for what is not an article', () => {
    for (const url of ['https://www.wikipedia.org/', 'https://zh.wikipedia.org/', 'https://zh.wikipedia.org/wiki/', 'https://zh.wikipedia.org/w/index.php?search=x', 'https://commons.wikimedia.org/wiki/File:A.jpg', 'https://example.com/wiki/Computer', 'https://notwikipedia.org/wiki/X', 'not a url'])
      expect(parseWikipediaUrl(url), url).toBeUndefined();
  });

  it('only reads a variant prefix on the Chinese edition', () => {
    expect(parseWikipediaUrl('https://zh-yue.wikipedia.org/zh-tw/電腦')).toBeUndefined();
    expect(parseWikipediaUrl('https://en.wikipedia.org/zh-tw/Computer')).toBeUndefined();
  });
});

describe('wikipediaTitleKey', () => {
  it('is the same for a title in either script, in full-width letters, or in other case', () => {
    expect(wikipediaTitleKey('計算機')).toBe(wikipediaTitleKey('计算机'));
    expect(wikipediaTitleKey('ＡＢＣ')).toBe(wikipediaTitleKey('abc'));
    expect(wikipediaTitleKey('Linux  kernel')).toBe(wikipediaTitleKey('linux kernel'));
  });

  it('keeps titles that differ only in a symbol apart', () => {
    expect(wikipediaTitleKey('C++')).not.toBe(wikipediaTitleKey('C'));
    expect(wikipediaTitleKey('C#')).not.toBe(wikipediaTitleKey('C++'));
  });
});

describe('foldWikipediaEditions', () => {
  const zhCN = wikipediaTarget('zh-CN');
  const zhTW = wikipediaTarget('zh-TW');

  it('keeps one copy of an article that came in several variants and on the mobile host', () => {
    const list = [
      result('https://zh.wikipedia.org/zh-tw/計算機', '計算機 - 維基百科', { rrfScore: 0.03, score: 1 }),
      result('https://zh.wikipedia.org/wiki/计算机', '计算机 - 维基百科', { rrfScore: 0.02, score: 0.6, sources: [{ source: 'bing', rank: 2 }] }),
      result('https://zh.m.wikipedia.org/zh-hk/計算機', '計算機 - 維基百科', { rrfScore: 0.015, score: 0.5, sources: [{ source: 'duckduckgo', rank: 4 }] }),
      result('https://example.com/other', 'Other', { rrfScore: 0.01, score: 0.3 }),
    ];
    const out = foldWikipediaEditions(list, zhCN);
    expect(urls(out)).toEqual(['https://zh.wikipedia.org/wiki/计算机', 'https://example.com/other']);
    // It stands in the place of the best-ranked copy with the best score, and the engines that returned any copy count for it.
    expect(out[0].score).toBe(1);
    expect(out[0].sources.map((s) => s.source).sort()).toEqual(['bing', 'duckduckgo', 'google']);
    expect(out[0].reprints).toBeUndefined();
  });

  it('keeps the copy in the user\'s own variant or with no variant named, then one in their script, then the best ranked', () => {
    const tw = result('https://zh.wikipedia.org/zh-tw/計算機', '計算機');
    const cn = result('https://zh.wikipedia.org/zh-cn/计算机', '计算机');
    const hans = result('https://zh.wikipedia.org/zh-hans/计算机', '计算机');
    const plain = result('https://zh.wikipedia.org/wiki/计算机', '计算机');
    // The user's variant and an unnamed one are equally good (the site serves the unnamed one in the user's variant): the better ranked of the two.
    expect(urls(foldWikipediaEditions([tw, cn, plain], zhCN))).toEqual([cn.url]);
    expect(urls(foldWikipediaEditions([tw, plain, cn], zhCN))).toEqual([plain.url]);
    expect(urls(foldWikipediaEditions([tw, hans, cn], zhCN))).toEqual([cn.url]);
    // Another variant in the user's script is better than one in the other script.
    expect(urls(foldWikipediaEditions([tw, hans], zhCN))).toEqual([hans.url]);
    expect(urls(foldWikipediaEditions([cn, tw], zhTW))).toEqual([tw.url]);
    // Only copies in the other script: the best ranked stays, and its address loses the variant (see "the address of an article").
    expect(shown(foldWikipediaEditions([hans, cn], zhTW))).toEqual(['https://zh.wikipedia.org/wiki/计算机']);
    // No variant to go by: the best ranked.
    expect(urls(foldWikipediaEditions([tw, cn], wikipediaTarget('zh')))).toEqual([tw.url]);
  });

  it('folds the other Chinese editions into the user\'s and lists them under it', () => {
    const list = [
      result('https://zh-yue.wikipedia.org/wiki/周杰倫', '周杰倫 - 維基百科', { rrfScore: 0.03, score: 1 }),
      result('https://zh.wikipedia.org/wiki/周杰伦', '周杰伦 - 维基百科', { rrfScore: 0.02, score: 0.7 }),
      result('https://zh-classical.wikipedia.org/wiki/周杰倫', '周杰倫', { rrfScore: 0.018, score: 0.6 }),
      result('https://wuu.wikipedia.org/wiki/周杰伦', '周杰伦', { rrfScore: 0.017, score: 0.55 }),
      result('https://zh-min-nan.wikipedia.org/wiki/周杰伦', '周杰伦', { rrfScore: 0.016, score: 0.5 }),
      result('https://example.com/other', 'Other', { rrfScore: 0.01, score: 0.3 }),
    ];
    const out = foldWikipediaEditions(list, zhCN);
    expect(urls(out)).toEqual(['https://zh.wikipedia.org/wiki/周杰伦', 'https://example.com/other']);
    expect(out[0].reprints?.map((copy) => copy.host)).toEqual(['zh-yue.wikipedia.org', 'zh-classical.wikipedia.org', 'wuu.wikipedia.org', 'zh-min-nan.wikipedia.org']);
    expect(out[0].score).toBe(1);
    expect(out[0].rrfScore).toBe(0.03);
  });

  it('keeps whichever edition the user reads: Cantonese, Wu, Classical Chinese', () => {
    const list = [
      result('https://zh.wikipedia.org/wiki/周杰伦', '周杰伦'),
      result('https://zh-yue.wikipedia.org/wiki/周杰倫', '周杰倫'),
      result('https://wuu.wikipedia.org/wiki/周杰伦', '周杰伦'),
      result('https://zh-classical.wikipedia.org/wiki/周杰倫', '周杰倫'),
    ];
    expect(urls(foldWikipediaEditions(list, wikipediaTarget('yue-HK')))).toEqual(['https://zh-yue.wikipedia.org/wiki/周杰倫']);
    expect(urls(foldWikipediaEditions(list, wikipediaTarget('wuu')))).toEqual(['https://wuu.wikipedia.org/wiki/周杰伦']);
    expect(urls(foldWikipediaEditions(list, wikipediaTarget('lzh')))).toEqual(['https://zh-classical.wikipedia.org/wiki/周杰倫']);
  });

  it('folds an English or Japanese article of the same title into the Chinese one', () => {
    const list = [result('https://en.wikipedia.org/wiki/Python', 'Python'), result('https://zh.wikipedia.org/wiki/Python', 'Python'), result('https://ja.wikipedia.org/wiki/Python', 'Python')];
    const out = foldWikipediaEditions(list, zhCN);
    expect(urls(out)).toEqual(['https://zh.wikipedia.org/wiki/Python']);
    expect(out[0].reprints?.map((copy) => copy.host)).toEqual(['en.wikipedia.org', 'ja.wikipedia.org']);
    // And the other way round for an English reader (the fold is on for them only when they choose it).
    expect(urls(foldWikipediaEditions([list[1], list[0], result('https://simple.wikipedia.org/wiki/Python', 'Python')], wikipediaTarget('en-GB')))).toEqual(['https://en.wikipedia.org/wiki/Python']);
  });

  it('leaves the other editions alone when the user\'s own is not there, but still joins the copies of one edition', () => {
    const list = [
      result('https://zh-yue.wikipedia.org/wiki/周杰倫', '周杰倫'),
      result('https://wuu.wikipedia.org/wiki/周杰伦', '周杰伦'),
      result('https://zh-yue.m.wikipedia.org/wiki/周杰倫', '周杰倫'),
    ];
    expect(urls(foldWikipediaEditions(list, zhCN))).toEqual(['https://zh-yue.wikipedia.org/wiki/周杰倫', 'https://wuu.wikipedia.org/wiki/周杰伦']);
  });

  it('does not fold articles of different titles, even when they are about the same thing', () => {
    const list = [result('https://zh.wikipedia.org/wiki/计算机', '计算机'), result('https://zh-yue.wikipedia.org/wiki/電腦', '電腦'), result('https://zh.wikipedia.org/wiki/C++', 'C++'), result('https://zh.wikipedia.org/wiki/C', 'C')];
    expect(foldWikipediaEditions(list, zhCN)).toEqual(list);
  });

  it('does not touch other sites, images, or an address that is not an article', () => {
    const image = result('https://zh.wikipedia.org/wiki/计算机', '计算机', { image: { src: 'https://upload.wikimedia.org/a.jpg' } as FusedResult['image'] });
    const list = [image, result('https://zh.wikipedia.org/zh-sg/計算機', '計算機'), result('https://example.com/zh-tw/计算机', '计算机'), result('https://zh.wikipedia.org/w/index.php?search=x', 'x'), result('https://zh.wikipedia.org/w/index.php?search=y', 'y')];
    expect(foldWikipediaEditions(list, zhCN)).toBe(list);
  });

  it('returns the very same list when there is nothing to fold, or no language to go by', () => {
    const list = [result('https://zh.wikipedia.org/wiki/计算机', '计算机'), result('https://en.wikipedia.org/wiki/Computer', 'Computer')];
    expect(foldWikipediaEditions(list, zhCN)).toBe(list);
    expect(foldWikipediaEditions([...list, result('https://zh-yue.wikipedia.org/wiki/计算机', '计算机')], undefined)).toHaveLength(3);
  });

  it('does not change the results it was given, and folding the output again changes nothing', () => {
    const list = [result('https://zh.wikipedia.org/zh-tw/計算機', '計算機'), result('https://zh.wikipedia.org/wiki/计算机', '计算机', { sources: [{ source: 'bing', rank: 3 }] }), result('https://en.wikipedia.org/wiki/计算机', '计算机')];
    const before = structuredClone(list);
    const once = foldWikipediaEditions(list, zhCN);
    expect(list).toEqual(before);
    expect(foldWikipediaEditions(once, zhCN)).toBe(once);
  });

  it('takes a late copy in, and a late copy it is itself the best of', () => {
    const fused = fuse([[hit('google', 'https://zh.wikipedia.org/wiki/周杰伦', '周杰伦', 1), hit('google', 'https://example.com/a', 'A', 2)]]);
    const withLate = mergeLateHits(fused, [hit('duckduckgo', 'https://zh-yue.wikipedia.org/wiki/周杰倫', '周杰倫', 1)]);
    expect(withLate).toHaveLength(3);
    const out = foldWikipediaEditions(withLate, zhCN);
    expect(urls(out)).toEqual(['https://zh.wikipedia.org/wiki/周杰伦', 'https://example.com/a']);
    expect(out[0].reprints?.map((copy) => copy.host)).toEqual(['zh-yue.wikipedia.org']);
    expect(out[0].late).toBeUndefined();
    // The same article again, from another variant: it is the same page, so it only adds the engine.
    const again = foldWikipediaEditions(mergeLateHits(out, [hit('bing', 'https://zh.wikipedia.org/zh-cn/周杰伦', '周杰伦', 2)]), zhCN);
    expect(urls(again)).toEqual(['https://zh.wikipedia.org/wiki/周杰伦', 'https://example.com/a']);
    expect(again[0].sources.map((s) => s.source).sort()).toEqual(['bing', 'google']);
    expect(again[0].reprints).toHaveLength(1);
  });
});

describe('the address of an article', () => {
  const zhCN = wikipediaTarget('zh-CN');
  const zhTW = wikipediaTarget('zh-TW');

  it('loses the variant that is in the other script than the user reads, folded or not', () => {
    const list = [
      result('https://zh.wikipedia.org/zh-tw/周杰倫音樂作品列表', 'a'),
      result('https://zh.wikipedia.org/zh-hant/周杰倫演唱會列表', 'b'),
      result('https://zh.wikipedia.org/wiki/驚嘆號?variant=zh-hk', 'c'),
      result('https://zh-tw.wikipedia.org/wiki/八度空間', 'd'),
      result('https://zh.m.wikipedia.org/zh-mo/葉惠美', 'e'),
      result('https://zh.wikipedia.org/zh-hk/說好的幸福呢?oldformat=true', 'f'),
    ];
    const out = foldWikipediaEditions(list, zhCN);
    expect(shown(out)).toEqual([
      'https://zh.wikipedia.org/wiki/周杰倫音樂作品列表',
      'https://zh.wikipedia.org/wiki/周杰倫演唱會列表',
      'https://zh.wikipedia.org/wiki/驚嘆號',
      'https://zh.wikipedia.org/wiki/八度空間',
      'https://zh.m.wikipedia.org/wiki/葉惠美',
      // Anything else in the query string is the address's own business.
      'https://zh.wikipedia.org/wiki/說好的幸福呢?oldformat=true',
    ]);
    // Only the address: the result is the same one, and the list is the same length and order.
    expect(out.map((r) => r.key)).toEqual(list.map((r) => r.key));
    expect(out.map((r) => r.title)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('is the same the other way round, for a Traditional reader', () => {
    const list = [result('https://zh.wikipedia.org/zh-cn/周杰伦', 'a'), result('https://zh.wikipedia.org/zh-hans/计算机', 'b'), result('https://zh.wikipedia.org/zh-sg/软件', 'c')];
    expect(shown(foldWikipediaEditions(list, zhTW))).toEqual(['https://zh.wikipedia.org/wiki/周杰伦', 'https://zh.wikipedia.org/wiki/计算机', 'https://zh.wikipedia.org/wiki/软件']);
  });

  it('keeps a variant in the user\'s own script, and one with none named', () => {
    const list = [result('https://zh.wikipedia.org/zh-cn/周杰伦', 'a'), result('https://zh.wikipedia.org/zh-hans/计算机', 'b'), result('https://zh.wikipedia.org/zh-sg/软件', 'c'), result('https://zh.wikipedia.org/wiki/猫', 'd')];
    expect(foldWikipediaEditions(list, zhCN)).toBe(list);
  });

  it('is left alone when the user\'s reading has no script to go by, or is not the Chinese edition', () => {
    const list = [result('https://zh.wikipedia.org/zh-tw/周杰倫', 'a'), result('https://zh.wikipedia.org/zh-cn/计算机', 'b')];
    for (const tag of ['zh', 'yue', 'en-GB', 'ja']) expect(foldWikipediaEditions(list, wikipediaTarget(tag)), tag).toBe(list);
  });

  it('is rewritten once: folding the output again changes nothing', () => {
    const once = foldWikipediaEditions([result('https://zh.wikipedia.org/zh-tw/周杰倫', 'a')], zhCN);
    expect(foldWikipediaEditions(once, zhCN)).toBe(once);
  });
});

describe('real results from Exa for the Chinese editions of Wikipedia', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/wikipedia-exa.json', import.meta.url), 'utf8')) as Record<string, { url: string; title: string }[]>;
  const fused = (query: string) => fuse([fixture[query].map((entry, index) => ({ source: 'exa' as const, url: entry.url, title: entry.title, snippet: '', rank: index + 1 }))]);
  /** The results that are the article called `title` (in any script) on a Wikipedia edition. */
  const copiesOf = (list: FusedResult[], title: string) => list.filter((r) => parseWikipediaUrl(r.url) && wikipediaTitleKey(parseWikipediaUrl(r.url)!.title) === wikipediaTitleKey(title));
  const scriptOfUrl = (url: string) => /\/zh-(?:cn|hans|sg|my)\//.test(url) ? 'hans' : /\/zh-(?:tw|hk|hant|mo)\//.test(url) ? 'hant' : undefined;

  it('is a list that really has the article several times over', () => {
    const list = fused('周杰伦');
    expect(copiesOf(list, '周杰伦').length).toBeGreaterThanOrEqual(8);
    expect(copiesOf(list, '周杰伦').map((r) => parseWikipediaUrl(r.url)!.edition)).toEqual(expect.arrayContaining(['zh', 'zh-yue', 'wuu']));
  });

  it('leaves one article of each title for a Simplified reader, with the other editions listed under it', () => {
    const list = fused('周杰伦');
    const out = foldWikipediaEditions(list, wikipediaTarget('zh-CN'));
    const jay = copiesOf(out, '周杰伦');
    expect(jay).toHaveLength(1);
    expect(parseWikipediaUrl(jay[0].url)).toMatchObject({ edition: 'zh' });
    expect(jay[0].reprints?.map((copy) => copy.host).sort()).toEqual(['wuu.wikipedia.org', 'zh-yue.wikipedia.org']);
    // Different articles stay: the talk page, the category, the English article, the discography.
    expect(out.some((r) => decodeURI(r.url).includes('Talk:周杰倫'))).toBe(true);
    expect(out.some((r) => r.url === 'https://en.wikipedia.org/wiki/Jay_Chou')).toBe(true);
    expect(out.length).toBeLessThan(list.length);
    // None of what is left is addressed in Traditional.
    expect(out.map((r) => scriptOfUrl(r.url)).filter((script) => script === 'hant')).toEqual([]);
  });

  it('does the same for a Traditional reader, and for a Cantonese one keeps the Cantonese article', () => {
    const list = fused('周杰伦');
    const tw = foldWikipediaEditions(list, wikipediaTarget('zh-TW'));
    expect(copiesOf(tw, '周杰伦')).toHaveLength(1);
    expect(tw.map((r) => scriptOfUrl(r.url)).filter((script) => script === 'hans')).toEqual([]);
    const yue = foldWikipediaEditions(list, wikipediaTarget('yue'));
    const jay = copiesOf(yue, '周杰伦');
    expect(jay.map((r) => parseWikipediaUrl(r.url)!.edition)).toEqual(['zh-yue']);
    expect(jay[0].reprints?.map((copy) => copy.host).sort()).toEqual(['wuu.wikipedia.org', 'zh.wikipedia.org']);
  });

  it('folds the Classical Chinese article and the Simplified, Singapore and Taiwan copies of 计算机 into the one article', () => {
    const list = fused('计算机');
    expect(copiesOf(list, '计算机').length).toBeGreaterThanOrEqual(4);
    const out = foldWikipediaEditions(list, wikipediaTarget('zh-CN'));
    const computer = copiesOf(out, '计算机');
    expect(computer).toHaveLength(1);
    expect(computer[0].reprints?.map((copy) => copy.host)).toEqual(['zh-classical.wikipedia.org']);
    // Folding what came out changes nothing.
    expect(foldWikipediaEditions(out, wikipediaTarget('zh-CN'))).toBe(out);
  });
});

describe('the fold in a search', () => {
  const wikipedia = [
    hit('google', 'https://zh.wikipedia.org/zh-tw/周杰倫', '周杰倫 - 維基百科', 1),
    hit('google', 'https://zh-yue.wikipedia.org/wiki/周杰倫', '周杰倫 - 維基百科，自由嘅百科全書', 2),
    hit('google', 'https://zh.wikipedia.org/wiki/周杰伦', '周杰伦 - 维基百科', 3),
    hit('google', 'https://wuu.wikipedia.org/wiki/周杰伦', '周杰伦 - 维基百科', 4),
    hit('google', 'https://example.com/jay', '周杰伦官网', 5),
  ];
  async function search(patch: { foldWikipediaEditions?: boolean }, browserLanguage: string | undefined) {
    const config = mergeConfig(DEFAULT_CONFIG, { judge: patch });
    for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = id === 'google';
    config.judge.provider = 'none';
    config.summary.enabled = false;
    const env: Env = { fetch: async () => new Response('{}'), runBrowserEngine: async () => wikipedia, browserLanguage };
    const events: string[][] = [];
    const run = await runSearch('周杰伦', config, env, { onEvent: (event) => event.type === 'fused' && events.push(event.results.map((r) => r.url)) });
    return { run: run.results.map((r) => r.url), events };
  }

  it('is on for a Chinese browser without anyone choosing', async () => {
    const { run, events } = await search({}, 'zh-CN');
    expect(run).toEqual(['https://zh.wikipedia.org/wiki/周杰伦', 'https://example.com/jay']);
    expect(events.at(-1)).toEqual(run);
  });

  it('keeps every copy for a browser that is not Chinese, or when it is switched off', async () => {
    expect((await search({}, 'en-US')).run).toHaveLength(5);
    expect((await search({}, undefined)).run).toHaveLength(5);
    expect((await search({ foldWikipediaEditions: false }, 'zh-CN')).run).toHaveLength(5);
  });

  it('is on for any browser that switched it on', async () => {
    const { run } = await search({ foldWikipediaEditions: true }, 'yue-HK');
    expect(run).toEqual(['https://zh-yue.wikipedia.org/wiki/周杰倫', 'https://example.com/jay']);
  });

  it('is a setting a stored config can carry, and leaves unset for the default', () => {
    expect(DEFAULT_CONFIG.judge.foldWikipediaEditions).toBeUndefined();
    expect(mergeConfig(DEFAULT_CONFIG, { judge: { foldWikipediaEditions: false } }).judge.foldWikipediaEditions).toBe(false);
    expect(mergeConfig(DEFAULT_CONFIG, { judge: { foldWikipediaEditions: undefined } }).judge.foldWikipediaEditions).toBeUndefined();
  });
});
