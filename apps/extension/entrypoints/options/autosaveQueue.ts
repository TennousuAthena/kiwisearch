export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
interface Snapshot<T> { value: T; json: string }
type Outcome = { ok: true } | { ok: false; error: unknown };
interface Submission<T> { id: number; snapshot: Snapshot<T>; outcome: Promise<Outcome> }

/** Debounced serial saves; page teardown can hand newer drafts to the background before older replies arrive. */
export function createAutosaveQueue<T>(save: (value: T, superseded?: readonly T[]) => Promise<void>, notify: (state: SaveState, error: string) => void, delayMs: number) {
  let saved: string | null = null;
  let latest: Snapshot<T> | null = null;
  let running: Promise<void> | null = null;
  let sequence = 0;
  const submissions: Submission<T>[] = [];
  // A failed response may mean the write never ran, or that its acknowledgement was lost.
  const uncertain = new Map<number, Snapshot<T>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const needsWrite = () => latest !== null && (latest.json !== saved || uncertain.size > 0);

  function submit(snapshot: Snapshot<T>) {
    const superseded = [...uncertain.values(), ...submissions.map((job) => job.snapshot)].filter((item) => item.json !== snapshot.json).map((item) => item.value);
    let request: Promise<void>;
    try { request = superseded.length ? save(snapshot.value, superseded) : save(snapshot.value); }
    catch (error) { request = Promise.reject(error); }
    // Attach rejection handling immediately, even when an earlier response is still pending.
    const outcome = request.then<Outcome>(() => ({ ok: true })).catch((error: unknown): Outcome => ({ ok: false, error }));
    submissions.push({ id: ++sequence, snapshot, outcome });
    notify('saving', '');
  }

  function monitor(): Promise<void> {
    if (running) return running;
    running = (async () => {
      let last: Outcome = { ok: true };
      while (submissions.length) {
        const job = submissions[0];
        last = await job.outcome;
        submissions.shift();
        if (last.ok) {
          saved = job.snapshot.json;
          for (const id of uncertain.keys()) if (id <= job.id) uncertain.delete(id);
        } else uncertain.set(job.id, job.snapshot);
        // A later handoff can repair an earlier failed request. Otherwise preserve the failed draft for retry.
        if (!submissions.length && last.ok && needsWrite()) submit(latest!);
      }
      clearTimer();
      if (last.ok) notify('saved', '');
      else notify('error', last.error instanceof Error ? last.error.message : String(last.error));
    })().finally(() => {
      running = null;
      if (submissions.length) void monitor();
    });
    return running;
  }

  const flush = (): Promise<void> => {
    clearTimer();
    if (submissions.length) return monitor();
    if (!needsWrite()) return Promise.resolve();
    submit(latest!);
    return monitor();
  };

  return {
    observe(value: T) {
      latest = { value, json: JSON.stringify(value) };
      if (saved === null) { saved = latest.json; return; }
      clearTimer();
      if (!needsWrite() && !submissions.length) { notify('idle', ''); return; }
      notify('saving', '');
      timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
    /** Send now. The background already serializes these requests, independently of this page's lifetime. */
    handoff(): Promise<void> {
      clearTimer();
      if (!latest) return Promise.resolve();
      const previous = submissions.at(-1);
      if (previous && previous.snapshot.json !== latest.json) submit(latest);
      return previous ? monitor() : flush();
    },
    dispose: clearTimer,
  };
}
