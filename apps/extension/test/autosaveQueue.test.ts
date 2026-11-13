import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutosaveQueue } from '../entrypoints/options/autosaveQueue';

afterEach(() => vi.useRealTimers());

describe('settings autosave drafts', () => {
  it('never writes the loaded value or an edit reverted before the delay', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const queue = createAutosaveQueue(save, vi.fn(), 500);
    queue.observe('original');
    queue.observe('edit');
    queue.observe('original');
    await vi.runAllTimersAsync();
    expect(save).not.toHaveBeenCalled();
  });

  it('flushes the newest draft immediately when a page is hidden', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const queue = createAutosaveQueue(save, vi.fn(), 500);
    queue.observe('original');
    queue.observe('first');
    queue.observe('latest');
    await queue.flush();
    expect(save.mock.calls).toEqual([['latest']]);
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed draft for explicit retry without another edit', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const notify = vi.fn();
    const queue = createAutosaveQueue(save, notify, 500);
    queue.observe('original');
    queue.observe('draft');
    await queue.flush();
    expect(notify).toHaveBeenLastCalledWith('error', 'offline');
    await queue.flush();
    expect(save.mock.calls).toEqual([['draft'], ['draft']]);
    expect(notify).toHaveBeenLastCalledWith('saved', '');
  });

  it('waits for a slow write and then saves only the newest intervening edit', async () => {
    let release!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
    const queue = createAutosaveQueue(save, vi.fn(), 500);
    queue.observe('original');
    queue.observe('first');
    const writing = queue.flush();
    queue.observe('intermediate');
    queue.observe('latest');
    const flushAgain = queue.flush();
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([writing, flushAgain]);
    expect(save.mock.calls).toEqual([['first'], ['latest']]);
  });

  it('writes a reversal after an in-flight write, rather than leaving the stale edit saved', async () => {
    let release!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
    const queue = createAutosaveQueue(save, vi.fn(), 500);
    queue.observe('original');
    queue.observe('edit');
    const writing = queue.flush();
    queue.observe('original');
    release();
    await writing;
    queue.dispose();
    expect(save.mock.calls).toEqual([['edit'], ['original']]);
  });

  it('hands the latest draft off before the previous request responds and deduplicates repeated hide events', async () => {
    let release!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
    const notify = vi.fn();
    const queue = createAutosaveQueue(save, notify, 500);
    queue.observe('original');
    queue.observe('first');
    const writing = queue.flush();
    queue.observe('latest');
    const handingOff = queue.handoff();
    void queue.handoff();
    expect(save.mock.calls).toEqual([['first'], ['latest', ['first']]]);
    expect(notify).toHaveBeenLastCalledWith('saving', '');
    release();
    await Promise.all([writing, handingOff]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith('saved', '');
  });

  it('hands off a reversal to the last saved value while the outgoing edit is still pending', async () => {
    let release!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
    const queue = createAutosaveQueue(save, vi.fn(), 500);
    queue.observe('original');
    queue.observe('outgoing');
    const writing = queue.flush();
    queue.observe('original');
    void queue.handoff();
    expect(save.mock.calls).toEqual([['outgoing'], ['original', ['outgoing']]]);
    release();
    await writing;
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('allows the handed-off latest draft to repair an older failed request', async () => {
    let reject!: (error: Error) => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
    const notify = vi.fn();
    const queue = createAutosaveQueue(save, notify, 500);
    queue.observe('original');
    queue.observe('first');
    const writing = queue.flush();
    queue.observe('latest');
    void queue.handoff();
    reject(new Error('old write failed'));
    await writing;
    expect(notify).toHaveBeenLastCalledWith('saved', '');
    expect(save.mock.calls).toEqual([['first'], ['latest', ['first']]]);
  });

  it('retains the newest handed-off failure for retry and never announces success for it', async () => {
    let release!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockRejectedValueOnce(new Error('latest failed')).mockResolvedValue(undefined);
    const notify = vi.fn();
    const queue = createAutosaveQueue(save, notify, 500);
    queue.observe('original');
    queue.observe('first');
    const writing = queue.flush();
    queue.observe('latest');
    void queue.handoff();
    release();
    await writing;
    expect(notify).toHaveBeenLastCalledWith('error', 'latest failed');
    expect(notify.mock.calls.some(([state]) => state === 'saved')).toBe(false);
    await queue.flush();
    expect(save.mock.calls.at(-1)?.[0]).toBe('latest');
    expect(notify).toHaveBeenLastCalledWith('saved', '');
  });
});
