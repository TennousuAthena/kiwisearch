import type { FusedResult, PipelineEvent } from '@kiwi-search/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSearchSessionController, type SessionPort } from '../src/lib/searchSessionController';
import { emptyState } from '../src/lib/searchState';

const hit = (key: string): FusedResult => ({ key, url: `https://example.com/${key}`, title: key, snippet: 'Evidence', sources: [], rrfScore: 1, score: 1, meta: {} });
class FakePort implements SessionPort {
  messages: unknown[] = []; disconnected = false; failWrites = false;
  listeners: ((m: unknown) => void)[] = []; disconnects: (() => void)[] = [];
  onMessage = { addListener: (fn: (m: unknown) => void) => { this.listeners.push(fn); } };
  onDisconnect = { addListener: (fn: () => void) => { this.disconnects.push(fn); } };
  postMessage(message: unknown) { if (this.failWrites) throw new Error('closed'); this.messages.push(message); }
  disconnect() { this.disconnected = true; this.disconnects.forEach((fn) => fn()); }
  event(event: PipelineEvent) { this.listeners.forEach((fn) => fn({ type: 'event', event })); }
  raw(msg: unknown) { this.listeners.forEach((fn) => fn(msg)); }
}
function setup() {
  vi.useFakeTimers();
  const ports: FakePort[] = [];
  const prompt = vi.fn(async () => {});
  const controller = createSearchSessionController({ connect: () => { const p = new FakePort(); ports.push(p); return p; }, prompt, onChange: () => {} });
  return { controller, ports, prompt };
}
const done = (results: FusedResult[] = []): PipelineEvent => ({ type: 'done', result: { query: 'q', mode: 'web', results, citations: [], sourceStats: [] } });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('search session lifecycle', () => {
  it.each(['empty', 'partial', 'summary'])('recovers from an unexpected disconnect during %s without losing arrived results', (phase) => {
    const { controller, ports } = setup(); controller.search('q', 'web');
    if (phase !== 'empty') ports[0].event({ type: 'fused', results: [hit('a')], partial: true });
    if (phase === 'summary') { ports[0].event({ type: 'summary_start', citations: [{ n: 1, url: hit('a').url, title: 'a' }] }); ports[0].event({ type: 'summary_delta', text: 'Partial [1]' }); }
    ports[0].disconnect();
    expect(controller.getState()).toMatchObject({ outcome: 'interrupted', stage: 'done', running: [], blocked: [] });
    expect(controller.getState()?.results).toHaveLength(phase === 'empty' ? 0 : 1);
    if (phase === 'summary') expect(controller.getState()).toMatchObject({ summary: 'Partial [1]', summaryStatus: 'stopped' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles keepalive write failures and cancels all timers', () => {
    const { controller, ports } = setup(); controller.search('q', 'web'); ports[0].failWrites = true;
    vi.advanceTimersByTime(20000);
    expect(controller.getState()?.outcome).toBe('interrupted'); expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores late messages and disconnects from superseded queries', () => {
    const { controller, ports } = setup(); controller.search('A', 'web'); controller.search('B', 'news');
    ports[0].event({ type: 'fused', results: [hit('old')] }); ports[0].raw({ type: 'fatal', error: 'old error' }); ports[0].disconnect();
    expect(controller.getState()).toMatchObject({ query: 'B', mode: 'news', results: [], outcome: 'active' });
    ports[1].event({ type: 'fused', results: [hit('new')] }); expect(controller.getState()?.results[0].key).toBe('new');
  });

  it('stops and restores unfinished snapshots without sending a new request', () => {
    const { controller, ports } = setup(); controller.search('q', 'web');
    ports[0].event({ type: 'fused', results: [hit('a')], partial: true });
    ports[0].event({ type: 'source_blocked', source: 'google', message: 'captcha', reason: 'captcha' });
    const snapshot = controller.getState()!; controller.stop();
    expect(controller.getState()).toMatchObject({ outcome: 'stopped', blocked: [], running: [], results: [hit('a')] });
    controller.restore(snapshot); expect(ports).toHaveLength(1);
    expect(controller.getState()).toMatchObject({ outcome: 'stopped', blocked: [], running: [] });
    expect(snapshot.blocked).toEqual(['google']);
  });

  it('does not turn a completed connection closing into an error', () => {
    const { controller, ports } = setup(); controller.search('q', 'web'); ports[0].event(done([hit('a')])); ports[0].disconnect();
    expect(controller.getState()).toMatchObject({ outcome: 'complete', results: [hit('a')] });
  });

  it('tells the extension it understands the early and final overviews', () => {
    const { controller, ports } = setup(); controller.search('q', 'web');
    expect(ports[0].messages[0]).toMatchObject({ type: 'search', query: 'q', phases: true });
  });

  it('keeps the search when the extension sends an event this page does not know', () => {
    const { controller, ports } = setup(); controller.search('q', 'web');
    ports[0].event({ type: 'fused', results: [hit('a')], partial: true });
    ports[0].event({ type: 'summary_added_later', detail: 1 } as unknown as PipelineEvent);
    expect(controller.getState()).toMatchObject({ query: 'q', outcome: 'active', results: [hit('a')] });
    ports[0].event(done([hit('a')]));
    expect(controller.getState()).toMatchObject({ outcome: 'complete', results: [hit('a')] });
  });

  it('retains source errors and readiness while partial results stay usable', () => {
    const { controller, ports } = setup(); controller.search('q', 'web');
    ports[0].raw({ type: 'readiness', enabled: 2, ready: 1 });
    ports[0].event({ type: 'source_error', source: 'google', error: 'HTTP 503', ms: 4 });
    ports[0].event({ type: 'fused', results: [hit('a')], partial: true });
    expect(controller.getState()).toMatchObject({ readiness: { enabled: 2, ready: 1 }, sourceErrors: { google: 'HTTP 503' }, results: [hit('a')] });
  });
});

describe('summary-only controls', () => {
  it('stops only auto-summary while keeping the search connection and results', () => {
    const { controller, ports } = setup(); controller.search('q', 'web');
    ports[0].event({ type: 'fused', results: [hit('a')], partial: true });
    ports[0].event({ type: 'summary_start', citations: [{ n: 1, url: hit('a').url, title: 'a' }] });
    ports[0].event({ type: 'summary_delta', text: 'Partial' }); controller.stopSummary();
    expect(ports[0].disconnected).toBe(false); expect(ports[0].messages.at(-1)).toEqual({ type: 'stop-summary' });
    ports[0].event({ type: 'summary_delta', text: 'ignored' }); ports[0].event({ type: 'late_results', source: 'bing', results: [hit('a'), hit('b')] });
    expect(controller.getState()).toMatchObject({ summary: 'Partial', summaryStatus: 'stopped' }); expect(controller.getState()?.results).toHaveLength(2);
  });

  it('retries frozen evidence and refreshes only when explicitly requested', () => {
    const { controller, ports } = setup();
    const a = { ...hit('a'), content: 'Checked original text' };
    controller.restore({ ...emptyState('q', 'news'), outcome: 'complete', stage: 'done', results: [a, hit('new')], summaryResults: [a], summaryAt: '2026-11-13T00:00:00Z', summaryEvidence: 'old' });
    controller.summarize();
    expect(ports[0].messages[0]).toMatchObject({ type: 'summarize', results: [a], reuse: true, summaryAt: '2026-11-13T00:00:00Z' });
    ports[0].event({ type: 'summary_start', citations: [{ n: 1, url: a.url, title: a.title }] });
    expect(controller.getState()).toMatchObject({ summaryEvidence: 'old', summaryStale: true });
    expect(controller.getState()?.summaryResults[0].content).toBe('Checked original text');
    controller.summarize({ fresh: true }); expect(ports[1].messages[0]).toMatchObject({ type: 'summarize', reuse: false });
    expect((ports[1].messages[0] as { results: FusedResult[] }).results).toHaveLength(2);
    ports[0].event({ type: 'summary_delta', text: 'stale' }); expect(controller.getState()?.summary).toBe('');
  });

  it('runs built-in streaming in the page and aborts it independently', async () => {
    const { controller, ports, prompt } = setup();
    let stream: ((delta: string) => void) | undefined; let signal: AbortSignal | undefined;
    prompt.mockImplementation(((_messages: unknown, onChunk: (text: string) => void, nextSignal: AbortSignal) => { stream = onChunk; signal = nextSignal; return new Promise<void>(() => {}); }) as never);
    controller.restore({ ...emptyState('q', 'web'), stage: 'done', outcome: 'complete', results: [hit('a')] }); controller.summarize();
    ports[0].event({ type: 'summary_prompt', citations: [], messages: [{ role: 'user', content: 'Evidence' }] });
    stream?.('first'); controller.stopSummary(); stream?.('late');
    expect(signal?.aborted).toBe(true); expect(controller.getState()).toMatchObject({ summary: 'first', summaryStatus: 'stopped' }); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the early overview when the user stops the final one, and offers the final evidence only once it is on screen', () => {
    const { controller, ports } = setup(); controller.search('q', 'web');
    ports[0].event({ type: 'fused', results: [hit('a'), hit('b')], partial: true });
    ports[0].event({ type: 'summary_start', citations: [{ n: 1, url: hit('a').url, title: 'a' }], phase: 'preliminary' });
    ports[0].raw({ type: 'summary-snapshot', results: [hit('a')], summaryAt: '2026-11-15T00:00:01.000Z' });
    ports[0].event({ type: 'summary_delta', text: 'Early', phase: 'preliminary' }); ports[0].event({ type: 'summary_done', text: 'Early', phase: 'preliminary' });
    ports[0].event({ type: 'summary_start', citations: [{ n: 1, url: hit('b').url, title: 'b' }], phase: 'final' });
    ports[0].raw({ type: 'summary-snapshot', results: [hit('b')], summaryAt: '2026-11-15T00:00:07.000Z' });
    expect(controller.getState()).toMatchObject({ summary: 'Early', summaryResults: [{ key: 'a' }], summaryAt: '2026-11-15T00:00:01.000Z', summaryUpdate: { results: [{ key: 'b' }] } });
    ports[0].event(done([hit('a'), hit('b')]));
    // Still waiting for the final overview, so the connection is expected to stay.
    expect(vi.getTimerCount()).toBe(1);
    controller.stopSummary();
    expect(ports[0].messages.at(-1)).toEqual({ type: 'stop-summary' });
    expect(controller.getState()).toMatchObject({ summary: 'Early', summaryStatus: 'done', summaryUpdate: undefined, summaryPhase: 'preliminary' });
    ports[0].event({ type: 'summary_done', text: 'Final', phase: 'final' });
    expect(controller.getState()?.summary).toBe('Early');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs the built-in model for each phase, ending the early run when the final prompt arrives', () => {
    const { controller, ports, prompt } = setup();
    const runs: { stream: (delta: string) => void; signal: AbortSignal; finish: () => void }[] = [];
    prompt.mockImplementation(((_messages: unknown, onChunk: (text: string) => void, signal: AbortSignal) => new Promise<void>((resolve) => { runs.push({ stream: onChunk, signal, finish: resolve }); })) as never);
    controller.search('q', 'web');
    ports[0].event({ type: 'fused', results: [hit('a')], partial: true });
    ports[0].event({ type: 'summary_start', citations: [], phase: 'preliminary' });
    ports[0].event({ type: 'summary_prompt', citations: [], messages: [], phase: 'preliminary' });
    runs[0].stream('Early');
    ports[0].event({ type: 'summary_start', citations: [], phase: 'final' });
    ports[0].event({ type: 'summary_prompt', citations: [], messages: [], phase: 'final' });
    expect(runs[0].signal.aborted).toBe(true);
    runs[0].stream(' stray'); runs[1].stream('Final');
    expect(controller.getState()).toMatchObject({ summary: 'Early', summaryUpdate: { text: 'Final' } });
  });

  it('swaps in the built-in final overview when it completes', async () => {
    const { controller, ports, prompt } = setup();
    let finish!: () => void; let stream!: (delta: string) => void;
    prompt.mockImplementation(((_m: unknown, onChunk: (text: string) => void) => { stream = onChunk; return new Promise<void>((resolve) => { finish = resolve; }); }) as never);
    controller.search('q', 'web');
    ports[0].event({ type: 'summary_start', citations: [], phase: 'preliminary' });
    ports[0].event({ type: 'summary_delta', text: 'Early', phase: 'preliminary' }); ports[0].event({ type: 'summary_done', text: 'Early', phase: 'preliminary' });
    ports[0].event({ type: 'summary_start', citations: [], phase: 'final' });
    ports[0].event({ type: 'summary_prompt', citations: [], messages: [], phase: 'final' });
    stream('Final'); finish(); await Promise.resolve(); await Promise.resolve();
    expect(controller.getState()).toMatchObject({ summary: 'Final', summaryPhase: 'final', summaryStatus: 'done', summaryUpdate: undefined });
  });

  it('converts summary connection errors into a local error without resetting search results', () => {
    const { controller, ports } = setup(); controller.restore({ ...emptyState('q', 'web'), stage: 'done', outcome: 'complete', results: [hit('a')] }); controller.summarize(); ports[0].disconnect();
    expect(controller.getState()).toMatchObject({ outcome: 'complete', results: [hit('a')], summaryStatus: 'error' });
  });

  it('includes ongoing news filters and ignores events after a fatal summary response', () => {
    const { controller, ports } = setup(); controller.search('q', 'news', undefined, { range: 'day', sort: 'date' }, false, { summarize: false });
    ports[0].event({ type: 'fused', results: [hit('a')], partial: true }); controller.summarize();
    expect(ports[1].messages[0]).toMatchObject({ news: { range: 'day', sort: 'date' } });
    ports[1].raw({ type: 'fatal', error: 'unavailable' }); ports[1].event({ type: 'summary_delta', text: 'obsolete' });
    expect(controller.getState()).toMatchObject({ summaryStatus: 'error', summaryError: 'unavailable', summary: '' });
    expect(ports[1].disconnected).toBe(true); expect(ports[0].disconnected).toBe(false);
  });

  it('ends a stalled built-in stream after its inactivity deadline', async () => {
    const { controller, ports, prompt } = setup();
    prompt.mockImplementation(() => new Promise<void>(() => {}));
    controller.restore({ ...emptyState('q', 'web'), stage: 'done', outcome: 'complete', results: [hit('a')] }); controller.summarize();
    ports[0].event({ type: 'summary_prompt', citations: [], messages: [] });
    vi.advanceTimersByTime(60000);
    expect(controller.getState()?.summaryStatus).toBe('error'); expect(vi.getTimerCount()).toBe(0);
  });
});
