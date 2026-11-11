import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, usableSources } from '../src/config';
import { bing } from '../src/engines/bing';
import { scholar } from '../src/engines/scholar';
import { fuse, mergeLateHits } from '../src/fusion';
import { runSearch } from '../src/pipeline';
import { arxiv, parseArxivFeed } from '../src/sources/arxiv';
import { crossref } from '../src/sources/crossref';
import { licenseLabel, openverse } from '../src/sources/openverse';
import { buildSummaryMessages } from '../src/summarize';
import type { Env, FusedResult, SearchHit } from '../src/types';
import { sourceContext } from './helpers';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function recordingEnv(body: string, contentType = 'application/json') {
  const calls: string[] = [];
  const env: Env = {
    fetch: async (input) => {
      calls.push(input);
      return new Response(body, { headers: { 'Content-Type': contentType } });
    },
  };
  return { env, calls };
}

describe('arXiv source', () => {
  it('parses a real Atom feed: stable URL, authors, year, abstract and PDF', () => {
    const hits = parseArxivFeed(fixture('arxiv.xml'));
    expect(hits).toHaveLength(2);
    expect(hits[0].url).toBe('https://arxiv.org/abs/2201.00978');
    expect(hits[0].title).toBe('PyramidTNT: Improved Transformer-in-Transformer Baselines with Pyramid Architecture');
    expect(hits[0].meta?.year).toBe(2022);
    expect(hits[0].meta?.authors?.length).toBeGreaterThan(1);
    expect(hits[0].meta?.pdfUrl).toBe('https://arxiv.org/pdf/2201.00978v1');
    expect(hits[0].content).toMatch(/^Transformer networks have achieved/);
    expect(hits[0].snippet.length).toBeLessThanOrEqual(320);
  });

  it('queries with plain all: terms and ranks the results', async () => {
    const { env, calls } = recordingEnv(fixture('arxiv.xml'), 'application/atom+xml');
    const hits = await arxiv.search('vision transformer', sourceContext(env, { enabled: true }, { mode: 'academic', count: 5 }));
    const url = new URL(calls[0]);
    expect(url.origin + url.pathname).toBe('https://export.arxiv.org/api/query');
    expect(url.searchParams.get('search_query')).toBe('all:vision transformer');
    expect(url.searchParams.get('max_results')).toBe('5');
    expect(hits.map((hit) => [hit.source, hit.rank])).toEqual([['arxiv', 1], ['arxiv', 2]]);
  });

  it('strips query-syntax characters and skips queries without Latin letters', async () => {
    const { env, calls } = recordingEnv(fixture('arxiv.xml'));
    await arxiv.search('say "hello" (world): x', sourceContext(env, { enabled: true }, { mode: 'academic' }));
    expect(new URL(calls[0]).searchParams.get('search_query')).toBe('all:say hello world x');
    expect(await arxiv.search('深度学习', sourceContext(env, { enabled: true }, { mode: 'academic' }))).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('Crossref source', () => {
  it('parses a real response into a DOI-keyed paper with metadata', async () => {
    const { env, calls } = recordingEnv(fixture('crossref.json'));
    const hits = await crossref.search('attention is all you need', sourceContext(env, { enabled: true }, { mode: 'academic', count: 4 }));
    const url = new URL(calls[0]);
    expect(url.searchParams.get('query')).toBe('attention is all you need');
    expect(url.searchParams.get('rows')).toBe('4');
    expect(hits[0]).toMatchObject({
      url: 'https://doi.org/10.1007/978-3-031-84300-6_13',
      title: 'Is Attention All You Need?',
      source: 'crossref',
      rank: 1,
      meta: { authors: ['Patrick Mineault'], year: 2025, citations: 55, venue: 'From Human Attention to Computational Attention' },
    });
  });

  it('strips JATS markup from abstracts and skips untitled works', async () => {
    const { env } = recordingEnv(
      JSON.stringify({
        message: {
          items: [
            { DOI: '10.1/ABC', title: ['<i>Fast</i> search'], abstract: '<jats:p>Abstract We study <jats:italic>fast</jats:italic> search.</jats:p>' },
            { DOI: '10.1/untitled' },
          ],
        },
      }),
    );
    const hits = await crossref.search('q', sourceContext(env, { enabled: true }, { mode: 'academic' }));
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('Fast search');
    expect(hits[0].content).toBe('We study fast search.');
    expect(hits[0].meta?.doi).toBe('10.1/abc');
  });
});

describe('Openverse source', () => {
  it('maps a real response to image hits and caps the page size at the anonymous limit', async () => {
    const { env, calls } = recordingEnv(fixture('openverse.json'));
    const hits = await openverse.search('sunset', sourceContext(env, { enabled: true }, { mode: 'images', count: 40 }));
    const url = new URL(calls[0]);
    expect(url.origin + url.pathname).toBe('https://api.openverse.org/v1/images/');
    expect(url.searchParams.get('page_size')).toBe('20');
    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({
      url: 'https://www.flickr.com/photos/29468339@N02/2775233719',
      title: 'Orange sunset',
      source: 'openverse',
      image: {
        src: 'https://live.staticflickr.com/3080/2775233719_3bb58f6c05.jpg',
        width: 500,
        height: 375,
        license: 'CC BY-NC-SA 2.0',
        creator: '@Doug88888',
      },
    });
    expect(hits[0].image?.thumbnail).toMatch(/^https:\/\/api\.openverse\.org\/v1\/images\/.+\/thumb\/$/);
  });

  it('labels licenses', () => {
    expect(licenseLabel('by', '4.0')).toBe('CC BY 4.0');
    expect(licenseLabel('cc0', '1.0')).toBe('CC0');
    expect(licenseLabel('pdm', '1.0')).toBe('Public Domain');
    expect(licenseLabel(null, null)).toBeUndefined();
  });
});

describe('Bing image tiles (hand-written fixture, see its header)', () => {
  const extract = () => {
    const window = new Window();
    window.document.write(fixture('bing-images.html'));
    return bing.extract(window.document as unknown as ParentNode, 'https://www.bing.com/images/search?q=orange+sunset', 'images');
  };

  it('reads the image file, page, thumbnail, cleaned title and size from each tile', () => {
    const hits = extract();
    expect(hits[0]).toMatchObject({
      url: 'https://photos.example.com/sunset',
      title: 'Orange sunset over the sea',
      rank: 1,
      image: { src: 'https://cdn.example.com/img/sunset.jpg', thumbnail: 'https://tse1.mm.bing.net/th?id=OIP.aaa&pid=Api', width: 240, height: 180 },
    });
  });

  it('resolves protocol-relative URLs and tolerates a lazy-loaded thumbnail', () => {
    expect(extract()[1]).toMatchObject({ title: 'Sunset & sea', image: { src: 'https://static.example.org/42.png', width: 320, height: 180 } });
  });

  it('skips tiles without an image file or with broken JSON, and repeated files', () => {
    const hits = extract();
    expect(hits.map((hit) => hit.title)).toEqual(['Orange sunset over the sea', 'Sunset & sea']);
    expect(hits.map((hit) => hit.rank)).toEqual([1, 2]);
  });

  it('builds mode-specific URLs and keeps web extraction unchanged', () => {
    expect(bing.buildUrl('a b', 10, 'images')).toBe('https://www.bing.com/images/search?q=a%20b&form=HDRSC2&first=1');
    expect(bing.buildUrl('a b', 10, 'web')).toBe('https://www.bing.com/search?q=a%20b&count=10');
    const window = new Window();
    window.document.write(fixture('bing.html'));
    expect(bing.extract(window.document as unknown as ParentNode, 'https://www.bing.com/search?q=x', 'web').length).toBeGreaterThanOrEqual(8);
  });

  it('is matched by the content script on image result pages and is ready on a tile', () => {
    expect(bing.matches).toContain('*://*.bing.com/images/search*');
    const window = new Window();
    window.document.write(fixture('bing-images.html'));
    expect(window.document.querySelector(bing.readySelector)).not.toBeNull();
  });
});

describe('Scholar PDF links (real fixture)', () => {
  it('captures the direct PDF link when Scholar offers one', () => {
    const window = new Window();
    window.document.write(fixture('scholar.html'));
    const hits = scholar.extract(window.document as unknown as ParentNode, 'https://scholar.google.com/', 'academic');
    const withPdf = hits.filter((hit) => hit.meta?.pdfUrl);
    expect(withPdf.length).toBeGreaterThan(0);
    for (const hit of withPdf) expect(hit.meta?.pdfUrl).toMatch(/^https?:\/\//);
  });
});

describe('image results in fusion', () => {
  const image = (source: SearchHit['source'], page: string, file: string, rank: number, extra = {}): SearchHit => ({
    source,
    url: page,
    title: page,
    snippet: '',
    rank,
    image: { src: file, thumbnail: `${file}?thumb`, ...extra },
  });

  it('identifies an image by its file, not by the page that shows it', () => {
    const fused = fuse([
      [image('bing', 'https://a.example/page', 'https://cdn.example/x.jpg', 1)],
      [image('openverse', 'https://b.example/other', 'https://cdn.example/x.jpg?utm_source=y', 1, { width: 800, height: 600, license: 'CC BY 4.0' })],
    ]);
    expect(fused).toHaveLength(1);
    expect(fused[0].sources.map((source) => source.source)).toEqual(['bing', 'openverse']);
    expect(fused[0].image).toMatchObject({ width: 800, height: 600, license: 'CC BY 4.0', thumbnail: 'https://cdn.example/x.jpg?thumb' });
  });

  it('keeps two images from the same page apart and ignores non-http files', () => {
    const fused = fuse([
      [
        image('bing', 'https://a.example/page', 'https://cdn.example/1.jpg', 1),
        image('bing', 'https://a.example/page', 'https://cdn.example/2.jpg', 2),
        image('bing', 'https://a.example/page', 'data:image/png;base64,AAAA', 3),
      ],
    ]);
    expect(fused).toHaveLength(2);
  });

  it('folds a late duplicate image into the existing result', () => {
    const initial = fuse([[image('bing', 'https://a.example/p', 'https://cdn.example/x.jpg', 1)]]);
    const merged = mergeLateHits(initial, [image('openverse', 'https://b.example/p', 'https://cdn.example/x.jpg', 1)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources).toHaveLength(2);
  });
});

describe('modes in the pipeline', () => {
  function configFor(...enabled: string[]) {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const [id, settings] of Object.entries(config.sources)) if (settings) settings.enabled = enabled.includes(id);
    config.summary.enabled = true;
    config.summary.contentFetcher = 'none';
    config.llm.apiKey = '{{SECRET_llmkey01}}';
    config.judge.apiKey = '{{SECRET_typesafe01}}';
    return config;
  }

  it('lists which sources serve which mode', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const ids = (mode: Parameters<typeof usableSources>[2]) =>
      usableSources(config, true, mode).filter((s) => !s.reason || s.reason === 'missing API key').map((s) => s.id);
    expect(ids('images').sort()).toEqual(['bing', 'openverse']);
    expect(ids('academic').sort()).toEqual(['arxiv', 'crossref', 'openalex', 'pubmed', 'scholar']);
    expect(ids('web')).toEqual(expect.arrayContaining(['google', 'bing', 'duckduckgo', 'brave', 'exa', 'deepseek']));
    expect(ids('web')).not.toContain('baidu');
    expect(ids('web')).not.toContain('openverse');
  });

  it('asks for more results in image mode and never summarizes or judges images', async () => {
    const config = configFor('bing', 'openverse');
    const seen: { engine: string; mode: string; count: number }[] = [];
    const calls: string[] = [];
    const env: Env = {
      fetch: async (input) => {
        calls.push(input);
        return new Response(fixture('openverse.json'));
      },
      runBrowserEngine: async (engine, _query, opts) => {
        seen.push({ engine: engine.id, mode: opts.mode, count: opts.count });
        return [{ source: 'bing', url: 'https://a.example/p', title: 'Pic', snippet: '', rank: 1, image: { src: 'https://cdn.example/x.jpg', thumbnail: 'https://cdn.example/t.jpg' } }];
      },
    };
    const events: string[] = [];
    const result = await runSearch('sunset', config, env, { mode: 'images', onEvent: (event) => events.push(event.type) });
    expect(seen).toEqual([{ engine: 'bing', mode: 'images', count: 40 }]);
    expect(result.results).toHaveLength(4);
    expect(result.results.every((r) => r.image)).toBe(true);
    expect(events).not.toContain('judged');
    expect(events.some((type) => type.startsWith('summary'))).toBe(false);
    expect(calls.every((url) => url.startsWith('https://api.openverse.org'))).toBe(true);
  });

  it('merges the same paper from Scholar, arXiv and Crossref in academic mode', async () => {
    const config = configFor('scholar', 'arxiv', 'crossref');
    config.summary.enabled = false;
    const title = 'Attention Is All You Need in Practice: A Study of Transformer Models';
    const env: Env = {
      fetch: async (input) => {
        if (input.includes('arxiv.org')) {
          return new Response(`<feed><entry><id>http://arxiv.org/abs/1706.03762v7</id><title>${title}</title><summary>abs</summary><published>2017-06-12T00:00:00Z</published><author><name>A B</name></author></entry></feed>`);
        }
        return new Response(JSON.stringify({ message: { items: [{ DOI: '10.5555/xyz', title: [title], issued: { 'date-parts': [[2017]] }, 'is-referenced-by-count': 100000, author: [{ given: 'A', family: 'B' }] }] } }));
      },
      runBrowserEngine: async () => [
        { source: 'scholar', url: 'https://publisher.example/paper/1', title, snippet: 's', rank: 1, meta: { year: 2017, authors: ['A B'], pdfUrl: 'https://publisher.example/paper/1.pdf' } },
      ],
    };
    const result = await runSearch('attention', config, env, { mode: 'academic' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].sources.map((s) => s.source).sort()).toEqual(['arxiv', 'crossref', 'scholar']);
    expect(result.results[0].meta).toMatchObject({ citations: 100000, pdfUrl: 'https://publisher.example/paper/1.pdf' });
  });
});

describe('academic summary prompt', () => {
  const paper: FusedResult = {
    key: 'k',
    url: 'https://doi.org/10.1/x',
    title: 'A paper',
    snippet: 'snippet',
    sources: [],
    rrfScore: 1,
    score: 1,
    meta: { authors: ['A', 'B', 'C', 'D', 'E'], venue: 'NeurIPS', year: 2020, citations: 42 },
  };

  it('asks for a literature overview and gives the model the paper metadata', () => {
    const [system, user] = buildSummaryMessages('q', [paper], new Map(), undefined, new Date('2026-01-01'), 'academic');
    expect(system.content).toContain('literature overview');
    expect(user.content).toContain('A, B, C, D et al. · NeurIPS · 2020 · cited by 42');
  });

  it('leaves the web prompt alone and marks sources as untrusted', () => {
    const [system, user] = buildSummaryMessages('q', [paper], new Map(), undefined, new Date('2026-01-01'));
    expect(system.content).toContain('direct 1-3 sentence answer');
    expect(system.content).toContain('untrusted');
    expect(user.content).not.toContain('cited by');
  });
});
