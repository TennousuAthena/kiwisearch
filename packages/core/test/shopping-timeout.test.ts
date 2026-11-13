import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { runSearch } from '../src/pipeline';
import type { BrowserRunOptions, SearchHit, SourceId } from '../src/types';

// Exercise the actual engine -> browser-source -> pipeline path rather than
// checking the field in isolation: one missed forwarding step breaks these.
afterEach(() => vi.useRealTimers());

describe('shopping source timeouts', () => {
  it.each([
    ['amazon', 15_000, 60_000],
    ['jd', 15_000, 15_000],
    ['amazon', 75_000, 75_000],
  ] as const)('%s respects its baseline and longer configured timeouts (%i -> %i)', async (id, configuredMs, expectedMs) => {
    vi.useFakeTimers();
    const config = structuredClone(DEFAULT_CONFIG);
    config.sourceTimeoutMs = configuredMs;
    let options!: BrowserRunOptions;
    const pending = runSearch('coffee', config, {
      fetch: vi.fn(),
      runBrowserEngine: (_engine, _query, opts) => {
        options = opts;
        return new Promise<SearchHit[]>((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
      },
    }, { mode: 'shopping', sources: [id as SourceId] });
    await vi.advanceTimersByTimeAsync(0);
    // The engine is queued, so this time must not consume its working allowance.
    await vi.advanceTimersByTimeAsync(10_000);
    options.onStart();
    await vi.advanceTimersByTimeAsync(expectedMs - 1);
    expect(options.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(options.signal.aborted).toBe(true);
    const result = await pending;
    expect(result.sourceStats[0].error).toBe(`timeout after ${expectedMs}ms`);
  });

  it('still cancels Amazon immediately despite its minimum timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let aborted = false;
    const pending = runSearch('coffee', structuredClone(DEFAULT_CONFIG), {
      fetch: vi.fn(),
      runBrowserEngine: (_engine, _query, opts) => new Promise<SearchHit[]>((_resolve, reject) => {
        opts.onStart();
        opts.signal.addEventListener('abort', () => { aborted = true; reject(opts.signal.reason); }, { once: true });
      }),
    }, { mode: 'shopping', sources: ['amazon'], signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('Cancelled by user'));
    expect(aborted).toBe(true);
    await expect(pending).rejects.toThrow('Cancelled by user');
  });
});
