import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import type { Env, FusedResult, PipelineEvent } from '../src/types';
import { summarizeSnapshot } from '../src/summarySnapshot';

const mocks = vi.hoisted(() => ({ contents: vi.fn(), flag: vi.fn(), stream: vi.fn() }));
vi.mock('../src/content', () => ({ fetchContents: mocks.contents }));
vi.mock('../src/judge', () => ({ judgeEnabled: () => true, flagInjectedContents: mocks.flag }));
vi.mock('../src/llm', async (original) => ({ ...(await original<typeof import('../src/llm')>()), chatStream: mocks.stream }));
const hit = (key: string): FusedResult => ({ key, url: `https://example.com/${key}`, title: key, snippet: `Excerpt ${key}`, sources: [], rrfScore: 1, score: 1, meta: {} });
const env = { fetch: vi.fn(() => { throw new Error('Unexpected search network request'); }), runBrowserEngine: vi.fn(() => { throw new Error('Must not search'); }) } as unknown as Env;
const config = () => ({ ...structuredClone(DEFAULT_CONFIG), llm: { ...DEFAULT_CONFIG.llm, apiKey: 'test' } });
beforeEach(() => {
  vi.clearAllMocks(); mocks.contents.mockResolvedValue(new Map([['a', 'Checked page body']])); mocks.flag.mockResolvedValue([]);
  mocks.stream.mockImplementation(async function* () { yield 'Answer '; yield '[1]'; });
});

describe('summary from existing evidence', () => {
  it('streams without querying sources and retries the same checked text without re-fetching', async () => {
    const events: PipelineEvent[] = []; const snapshots: FusedResult[][] = [];
    const manualConfig = config(); manualConfig.summary.enabled = false;
    const first = await summarizeSnapshot('Question', [hit('a'), { ...hit('hidden'), hidden: { reason: 'junk' } }], manualConfig, env, {
      mode: 'web', onEvent: (event) => events.push(event), onSnapshot: (results) => snapshots.push(structuredClone(results)),
    });
    expect(first.summary).toBe('Answer [1]'); expect(first.citations).toEqual([{ n: 1, url: hit('a').url, title: 'a' }]);
    expect(events.map((e) => e.type)).toEqual(['summary_start', 'summary_delta', 'summary_delta', 'summary_done']);
    expect(snapshots.at(-1)?.[0].content).toBe('Checked page body');
    expect(env.runBrowserEngine).not.toHaveBeenCalled(); expect(env.fetch).not.toHaveBeenCalled();
    mocks.contents.mockResolvedValue(new Map([['a', 'CHANGED NETWORK BODY']]));
    const retry = await summarizeSnapshot('Question', first.results, config(), env, { mode: 'web', reuse: true, summaryAt: first.summaryAt });
    expect(mocks.contents).toHaveBeenCalledTimes(1); expect(mocks.flag).toHaveBeenCalledTimes(1);
    expect(retry.summaryAt).toBe(first.summaryAt); expect(retry.citations).toEqual(first.citations);
    expect(JSON.stringify(mocks.stream.mock.calls.at(-1)?.[2])).toContain('Checked page body');
    expect(JSON.stringify(mocks.stream.mock.calls.at(-1)?.[2])).not.toContain('CHANGED NETWORK BODY');
    await summarizeSnapshot('Question', [hit('a'), hit('new')], config(), env, { mode: 'web' });
    expect(mocks.contents).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mocks.stream.mock.calls.at(-1)?.[2])).toContain('CHANGED NETWORK BODY');
  });

  it('does not restore rejected page contents on retry', async () => {
    mocks.flag.mockResolvedValue(['a']);
    const first = await summarizeSnapshot('q', [{ ...hit('a'), content: 'original untrusted content' }], config(), env, { mode: 'web' });
    expect(first.results[0].content).toBeUndefined();
    await summarizeSnapshot('q', first.results, config(), env, { mode: 'web', reuse: true });
    expect(JSON.stringify(mocks.stream.mock.calls.at(-1)?.[2])).toContain('Excerpt a');
    expect(JSON.stringify(mocks.stream.mock.calls.at(-1)?.[2])).not.toContain('untrusted content');
  });

  it('keeps only excerpts when stopped during page checks, so retry cannot bypass checking', async () => {
    const summary = new AbortController(); const snapshots: FusedResult[][] = [];
    mocks.flag.mockImplementation(async () => { summary.abort(); throw new Error('Stopped during content check'); });
    const first = await summarizeSnapshot('q', [{ ...hit('a'), content: 'original unchecked content' }], config(), env, {
      mode: 'web', summarySignal: summary.signal, onSnapshot: (results) => snapshots.push(structuredClone(results)),
    });
    expect(snapshots).toHaveLength(1); expect(snapshots[0][0].content).toBeUndefined();
    expect(first.results[0].content).toBeUndefined();
    await summarizeSnapshot('q', first.results, config(), env, { mode: 'web', reuse: true, summaryAt: first.summaryAt });
    expect(JSON.stringify(mocks.stream.mock.calls.at(-1)?.[2])).toContain('Excerpt a');
    expect(JSON.stringify(mocks.stream.mock.calls.at(-1)?.[2])).not.toContain('unchecked content');
    expect(JSON.stringify(mocks.stream.mock.calls.at(-1)?.[2])).not.toContain('Checked page body');
  });

  it('returns the same prompt and frozen citation snapshot to the built-in page model', async () => {
    const conf = config(); conf.summary.provider = 'chrome-builtin';
    const events: PipelineEvent[] = [];
    await summarizeSnapshot('q', [hit('a')], conf, env, { mode: 'web', onEvent: (event) => events.push(event) });
    expect(events.map((e) => e.type)).toEqual(['summary_start', 'summary_prompt']);
    const prompt = events.find((e) => e.type === 'summary_prompt');
    expect(prompt?.citations[0].n).toBe(1); expect(JSON.stringify(prompt?.messages)).toContain('Quick-answer eligibility');
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('stops the summary without aborting the search signal', async () => {
    const main = new AbortController(); const summary = new AbortController(); const events: PipelineEvent[] = [];
    mocks.stream.mockImplementation(async function* (_fetch, _config, _messages, { signal }) {
      yield 'first'; summary.abort(); signal.throwIfAborted(); yield 'never';
    });
    await summarizeSnapshot('q', [hit('a')], config(), env, { mode: 'web', signal: main.signal, summarySignal: summary.signal, onEvent: (event) => events.push(event) });
    expect(main.signal.aborted).toBe(false); expect(events.at(-1)?.type).toBe('summary_stopped');
    expect(events.filter((e) => e.type === 'summary_delta')).toHaveLength(1);
  });

  it('propagates whole-search cancellation and skips non-text modes and missing models', async () => {
    const main = new AbortController(); main.abort();
    await expect(summarizeSnapshot('q', [hit('a')], config(), env, { mode: 'web', signal: main.signal })).rejects.toBeDefined();
    const events: PipelineEvent[] = [];
    const skipped = await summarizeSnapshot('q', [hit('a')], structuredClone(DEFAULT_CONFIG), env, { mode: 'web', onEvent: (event) => events.push(event) });
    expect(skipped.citations).toEqual([]); expect(events).toEqual([]);
    await summarizeSnapshot('q', [hit('a')], config(), env, { mode: 'shopping', onEvent: (event) => events.push(event) });
    expect(events).toEqual([]);
  });
});
