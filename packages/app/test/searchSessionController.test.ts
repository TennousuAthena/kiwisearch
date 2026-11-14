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
