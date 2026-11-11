import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, resultCount, usableSources } from '../src/config';
import { bilibili } from '../src/engines/bilibili';
import { youtube } from '../src/engines/youtube';
import { applyDomainRules } from '../src/judge';
import { fuse } from '../src/fusion';
import { runSearch } from '../src/pipeline';
import { isSearchMode, modeHasText } from '../src/types';
import type { Env, PipelineEvent, SearchHit } from '../src/types';
import { normalizeUrl } from '../src/url';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const dom = (html: string) => {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as ParentNode;
};
const ytPage = (data: unknown) => `<html><body><script>var ytInitialData = ${JSON.stringify(data)};</script></body></html>`;
const renderer = (extra: Record<string, unknown> = {}) => ({
  videoRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: 'A video' }] }, ...extra },
});

describe('YouTube engine (real captured response, see the fixture header)', () => {
  const hits = youtube.extract(dom(fixture('youtube.html')), 'https://www.youtube.com/results?search_query=rrf', 'video');

  it('reads every video in order, one per id', () => {
    expect(hits).toHaveLength(12);
    expect(hits.map((hit) => hit.rank)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(12);
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/);
      expect(hit.title.length).toBeGreaterThan(0);
      expect(hit.video?.thumbnail).toMatch(/^https:\/\/i\.ytimg\.com\/vi\//);
    }
  });

  it('keeps title, channel, length, views, age and the highlighted description snippet', () => {
    expect(hits[0]).toMatchObject({
      url: 'https://www.youtube.com/watch?v=6dDvfGrxFns',
      host: 'youtube.com',
      title: 'Understanding Reciprocal Rank Fusion in Hybrid Search [Advanced RAG]',
      snippet: 'ragsystem #hybridsearch #genai #llm Reciprocal Rank Fusion (RRF) is an effective and simple method for combining multiple ...',
      video: {
        channel: 'TechViz - The Data Science Guy',
        channelUrl: 'https://www.youtube.com/@TechVizTheDataScienceGuy',
        duration: '8:16',
        views: '11,007 views',
        published: '2y ago',
      },
    });
    expect(hits[0].video?.thumbnail).toContain('/vi/6dDvfGrxFns/');
  });

  it('ignores shelves and other items, broken scripts and pages without data', () => {
    const noise = { contents: [{ gridShelfViewModel: { videoRenderer: undefined } }, renderer(), { videoRenderer: { title: { simpleText: 'no id' } } }, renderer()] };
    expect(youtube.extract(dom(ytPage(noise)), 'https://www.youtube.com/results', 'video')).toHaveLength(1);
    expect(youtube.extract(dom('<script>var ytInitialData = {oops</script>'), 'https://www.youtube.com/results', 'video')).toEqual([]);
    expect(youtube.extract(dom('<script>console.log("ytInitialData = nothing")</script><p>hi</p>'), 'https://www.youtube.com/results', 'video')).toEqual([]);
    expect(youtube.extract(dom('<html><body></body></html>'), 'https://www.youtube.com/results', 'video')).toEqual([]);
  });

  it('copes with live streams (no length) and falls back to the id-based thumbnail', () => {
    const [live] = youtube.extract(
      dom(ytPage({ a: [renderer({ viewCountText: { runs: [{ text: '1.2K' }, { text: ' watching' }] }, badges: [{ metadataBadgeRenderer: { label: 'LIVE' } }] })] })),
      'https://www.youtube.com/results',
      'video',
    );
    expect(live.video).toMatchObject({ duration: undefined, views: '1.2K watching', thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg' });
  });

  it('builds the search URL and recognizes the consent page as a block', () => {
    expect(youtube.buildUrl('a b', 16, 'video')).toBe('https://www.youtube.com/results?search_query=a%20b');
    expect(youtube.isBlockedUrl?.('https://consent.youtube.com/m?continue=x')).toBe(true);
    expect(youtube.isBlockedUrl?.('https://www.youtube.com/sorry/index')).toBe(true);
    expect(youtube.isBlockedUrl?.('https://www.youtube.com/results?search_query=x')).toBe(false);
    expect(youtube.matches).toEqual(expect.arrayContaining(['*://www.youtube.com/results*', '*://consent.youtube.com/*']));
  });
});

describe('Bilibili engine (real captured page, see the fixture header)', () => {
  const hits = bilibili.extract(dom(fixture('bilibili.html')), 'https://search.bilibili.com/video?keyword=x', 'video');

  it('reads every card in order with a canonical video URL', () => {
    expect(hits).toHaveLength(12);
    expect(hits.map((hit) => hit.rank)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    for (const hit of hits) {
      expect(hit.url).toMatch(/^https:\/\/www\.bilibili\.com\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/$/);
      expect(hit.title.length).toBeGreaterThan(0);
      expect(hit.video?.thumbnail).toMatch(/^https:\/\/i\d\.hdslb\.com\//);
    }
  });

  it('keeps title (without the highlight markup), uploader, age, length and views', () => {
    expect(hits[0]).toMatchObject({
      url: 'https://www.bilibili.com/video/BV1N2WT6tE1H/',
      host: 'bilibili.com',
      title: '从夯到拉排名不同游戏的戴拿强度',
      snippet: '',
      video: { channel: '出租房房东古三帝', channelUrl: 'https://space.bilibili.com/234436327', published: '昨天', duration: '04:10', views: '942播放' },
    });
    expect(hits[0].video?.thumbnail).toMatch(/^https:\/\/i2\.hdslb\.com\/bfs\/archive\/801ab76bbd09638e9644d8fd8291be5f80d07f29\.jpg/);
  });

  const card = (href: string, title = 'T') =>
    `<div class="bili-video-card"><a href="${href}"><h3 class="bili-video-card__info--tit">${title}</h3></a></div>`;

  it('keeps cards without a cover, drops other kinds of links, and strips parts and tracking', () => {
    const doc = dom(
      card('//www.bilibili.com/video/BV1abcdefghi/?p=3&spm_id_from=x', 'Part three') +
        card('//live.bilibili.com/12345', 'A live room') +
        card('//cm.bilibili.com/ad/1', 'An ad') +
        card('//www.bilibili.com/video/av170001', 'Old id') +
        card('//www.bilibili.com/video/BV1abcdefghi/', 'Same video again'),
    );
    const found = bilibili.extract(doc, 'https://search.bilibili.com/video?keyword=x', 'video');
    expect(found.map((hit) => hit.url)).toEqual(['https://www.bilibili.com/video/BV1abcdefghi/', 'https://www.bilibili.com/video/av170001/']);
    expect(found[0].video?.thumbnail).toBeUndefined();
  });

  it('builds the search URL and waits for card titles', () => {
    expect(bilibili.buildUrl('倒数 排名', 16, 'video')).toBe('https://search.bilibili.com/video?keyword=%E5%80%92%E6%95%B0%20%E6%8E%92%E5%90%8D');
    expect(dom(fixture('bilibili.html')).querySelector(bilibili.readySelector)).not.toBeNull();
  });
});

describe('video URLs share one key', () => {
  it('collapses every YouTube form of a video', () => {
    const key = normalizeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(key).toBe('youtube:dQw4w9WgXcQ');
    for (const url of [
      'https://youtu.be/dQw4w9WgXcQ?t=42',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&utm_source=x',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]) {
      expect(normalizeUrl(url)).toBe(key);
    }
  });

  it('keeps other YouTube pages and different videos apart', () => {
    expect(normalizeUrl('https://www.youtube.com/watch?v=aaaaaaaaaaa')).not.toBe(normalizeUrl('https://www.youtube.com/watch?v=bbbbbbbbbbb'));
    expect(normalizeUrl('https://www.youtube.com/@someone')).toBe('youtube.com/@someone');
    expect(normalizeUrl('https://www.youtube.com/watch?v=short')).not.toMatch(/^youtube:/);
    expect(normalizeUrl('https://youtu.be/')).toBe('youtu.be');
  });

  it('collapses Bilibili parts and the BV form of a video, keeping other pages', () => {
    const key = normalizeUrl('https://www.bilibili.com/video/BV1N2WT6tE1H/');
    expect(key).toBe('bilibili:BV1N2WT6tE1H');
    expect(normalizeUrl('https://m.bilibili.com/video/BV1N2WT6tE1H?p=2&share_source=copy')).toBe(key);
    expect(normalizeUrl('https://www.bilibili.com/video/av170001/')).toBe('bilibili:av170001');
    expect(normalizeUrl('https://space.bilibili.com/234436327')).toBe('space.bilibili.com/234436327');
  });
});

describe('video results in fusion', () => {
  const hit = (source: SearchHit['source'], url: string, rank: number, video: SearchHit['video']): SearchHit => ({ source, url, title: url, snippet: '', rank, video });

  it('merges the same video found under different links and fills in missing details', () => {
    const fused = fuse([
      [hit('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 1, { thumbnail: 'https://i.ytimg.com/a.jpg', channel: 'Rick' })],
      [hit('searxng', 'https://youtu.be/dQw4w9WgXcQ', 3, { thumbnail: 'https://other/b.jpg', channel: undefined, duration: '3:33' })],
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0].sources.map((s) => s.source)).toEqual(['youtube', 'searxng']);
    expect(fused[0].video).toEqual({ thumbnail: 'https://i.ytimg.com/a.jpg', channel: 'Rick', duration: '3:33' });
  });

  it('interleaves two platforms by rank instead of stacking one after the other', () => {
    const list = (source: SearchHit['source'], prefix: string) => [1, 2, 3].map((n) => hit(source, `https://${prefix}.example/${n}`, n, { thumbnail: 't' }));
    const order = fuse([list('youtube', 'yt'), list('bilibili', 'bili')]).map((r) => r.url.slice(8, 12));
    expect(order.slice(0, 2).sort()).toEqual(['bili', 'yt.e'].sort());
  });

  it('lets blocked domains remove a platform or a channel host from the list', () => {
    const fused = fuse([[hit('youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', 1, { thumbnail: 't' }), hit('bilibili', 'https://www.bilibili.com/video/BV1abcdefghi/', 2, { thumbnail: 't' })]]);
    const config = structuredClone(DEFAULT_CONFIG);
    config.judge.blockedDomains = ['bilibili.com'];
    const out = applyDomainRules(fused, config.judge);
    expect(out.map((r) => [r.url.includes('bilibili'), r.hidden?.reason])).toEqual([[false, undefined], [true, 'blocked']]);
  });
});

describe('video mode in the pipeline', () => {
  function configFor(...enabled: string[]) {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = enabled.includes(id);
    config.summary.enabled = true;
    config.llm.apiKey = '{{SECRET_llmkey01}}';
    config.judge.apiKey = '{{SECRET_typesafe01}}';
    config.rerank.provider = 'llm';
    return config;
  }

  it('knows the mode, its result count and which sources serve it', () => {
    expect(isSearchMode('video')).toBe(true);
    expect(modeHasText('video')).toBe(false);
    expect(modeHasText('web')).toBe(true);
    expect(resultCount(DEFAULT_CONFIG, 'video')).toBe(16);
    expect(resultCount(DEFAULT_CONFIG, 'images')).toBe(40);
    expect(resultCount(DEFAULT_CONFIG, 'web')).toBe(10);
    const ids = usableSources(DEFAULT_CONFIG, true, 'video').filter((s) => !s.reason).map((s) => s.id);
    expect(ids.sort()).toEqual(['bilibili', 'youtube']);
    expect(usableSources(DEFAULT_CONFIG, true, 'web').find((s) => s.id === 'youtube')?.reason).toMatch(/not available in web/);
    expect(usableSources(DEFAULT_CONFIG, false, 'video').every((s) => s.reason)).toBe(true);
  });

  it('asks only the video platforms, for 16 results, and never judges, reranks or summarizes', async () => {
    const config = configFor('google', 'youtube', 'bilibili', 'openverse');
    const asked: { engine: string; mode: string; count: number }[] = [];
    const fetched: string[] = [];
    const env: Env = {
      fetch: async (input) => {
        fetched.push(input);
        throw new Error('no network call expected in video mode');
      },
      runBrowserEngine: async (engine, _query, opts) => {
        asked.push({ engine: engine.id, mode: opts.mode, count: opts.count });
        const id = engine.id === 'youtube' ? 'aaaaaaaaaaa' : 'bbbbbbbbbbb';
        return [{ source: engine.id, url: `https://video.example/${id}`, title: `${engine.id} video`, snippet: '', rank: 1, video: { thumbnail: 't', channel: 'c' } }];
      },
    };
    const events: PipelineEvent[] = [];
    const result = await runSearch('rrf', config, env, { mode: 'video', onEvent: (event) => events.push(event) });
    expect(asked.sort((a, b) => a.engine.localeCompare(b.engine))).toEqual([
      { engine: 'bilibili', mode: 'video', count: 16 },
      { engine: 'youtube', mode: 'video', count: 16 },
    ]);
    expect(fetched).toEqual([]);
    expect(result.mode).toBe('video');
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.video)).toBe(true);
    const types = events.map((event) => event.type);
    expect(types).not.toContain('judged');
    expect(types).not.toContain('reranked');
    expect(types.some((type) => type.startsWith('summary'))).toBe(false);
  });

  it('reports a clear error when no video platform is enabled', async () => {
    const config = configFor('google');
    await expect(runSearch('rrf', config, { fetch, runBrowserEngine: async () => [] }, { mode: 'video' })).rejects.toThrow(/video/);
  });
});
