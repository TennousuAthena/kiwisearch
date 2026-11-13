import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig, usableSources } from '../src/config';
import { fuse, mergeLateHits } from '../src/fusion';
import { runSearch } from '../src/pipeline';
import type { PipelineEvent, SearchHit, SourceId } from '../src/types';

const ids = ['taobao', 'jd', 'amazon'] as const;
const offer = (source: SourceId, price = '¥199'): SearchHit => ({
  source, rank: 1, url: `https://${source}.com/item/1`,
  title: 'The same wireless headphones product title', snippet: 'Wireless headphones with noise cancellation',
  product: { price, shop: `${source} shop`, thumbnail: `https://${source}.com/product.jpg` },
});

describe('shopping integration', () => {
  it('makes all three shops available only in shopping and preserves existing source choices', () => {
    const config = mergeConfig(DEFAULT_CONFIG, { sources: { google: { enabled: false }, jd: { enabled: false } } });
    expect(config.sources.google?.enabled).toBe(false);
    expect(config.sources.jd?.enabled).toBe(false);
    expect(config.sources.taobao?.enabled).toBe(true);
    expect(config.sources.amazon?.enabled).toBe(true);
    expect(usableSources(config, true, 'shopping').filter((s) => !s.reason).map((s) => s.id).sort()).toEqual(['amazon', 'taobao']);
    for (const id of ids) {
      expect(usableSources(DEFAULT_CONFIG, true, 'web').find((s) => s.id === id)?.reason).toBe('not available in web mode');
      expect(usableSources(DEFAULT_CONFIG, false, 'shopping').find((s) => s.id === id)?.reason).toBe('needs browser extension');
    }
  });

  it('retains separate offers and their displayed prices without invoking any text models', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.judge.apiKey = 'test-key';
    config.rerank = { ...config.rerank, provider: 'cohere', apiKey: 'test-key' };
    config.llm.apiKey = 'test-key';
    const fetch = vi.fn(async () => { throw new Error('Shopping must not call a model or fetch product pages'); });
    const engines: SourceId[] = [];
    const events: PipelineEvent[] = [];
    const result = await runSearch('headphones', config, {
      fetch,
      runBrowserEngine: async (engine, _query, options) => {
        expect(options.mode).toBe('shopping');
        engines.push(engine.id);
        return [offer(engine.id, engine.id === 'amazon' ? '$29.99' : '¥199')];
      },
    }, { mode: 'shopping', summarize: true, onEvent: (e) => events.push(e) });
    expect(engines.sort()).toEqual([...ids].sort());
    expect(result.results).toHaveLength(3);
    expect(result.results.map((r) => r.product?.price).sort()).toEqual(['$29.99', '¥199', '¥199']);
    expect(result.results.every((r) => !r.reprints)).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.summary).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(events.some((e) => ['judged', 'reranked', 'summary_start', 'summary_prompt'].includes(e.type))).toBe(false);
  });

  it('keeps product metadata in partial and late fusion without folding different shops', () => {
    const initial = fuse([[offer('taobao')]]);
    expect(initial[0].product).toEqual(offer('taobao').product);
    const merged = mergeLateHits(initial, [offer('jd', '¥209')], {}, undefined, { urlOnly: true });
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.sources[0].source === 'jd')).toMatchObject({ late: true, product: { price: '¥209' } });
    expect(fuse([[offer('taobao')], [offer('jd')]])).toHaveLength(2);
    const duplicate = { ...offer('amazon', '$25.00'), url: offer('taobao').url };
    const sameUrl = mergeLateHits(initial, [duplicate], {}, undefined, { urlOnly: true });
    expect(sameUrl).toHaveLength(1);
    expect(sameUrl[0].product?.price).toBe('¥199');
    expect(sameUrl[0].sources).toHaveLength(2);
  });

  it('keeps products out of the judge when a login-blocked shop finishes late', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sources.jd = { enabled: false };
    config.judge.apiKey = 'test-key';
    config.llm.apiKey = 'test-key';
    const fetch = vi.fn(async () => { throw new Error('Late products must not call a model'); });
    let release!: (hits: SearchHit[]) => void;
    const waiting = new Promise<SearchHit[]>((resolve) => { release = resolve; });
    let received!: (event: Extract<PipelineEvent, { type: 'late_results' }>) => void;
    const late = new Promise<Extract<PipelineEvent, { type: 'late_results' }>>((resolve) => { received = resolve; });
    const result = await runSearch('headphones', config, {
      fetch,
      runBrowserEngine: async (engine, _query, options) => {
        if (engine.id === 'taobao') {
          options.onBlocked('login');
          return waiting;
        }
        return [offer('amazon', '$29.99')];
      },
    }, { mode: 'shopping', onEvent: (event) => { if (event.type === 'late_results') received(event); } });
    expect(result.results).toHaveLength(1);
    release([offer('taobao')]);
    expect((await late).results).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
