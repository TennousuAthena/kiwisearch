import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createAutosaveQueue, type SaveState } from './autosaveQueue';

export type { SaveState } from './autosaveQueue';

/** Opening the page does not save. Failed drafts survive, and pagehide flushes the latest queued value. */
export function useAutosave<T>(value: T, loaded: boolean, save: (value: T, superseded?: readonly T[]) => Promise<void>, delayMs = 500): { state: SaveState; error: string; retry: () => void } {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState('');
  const saveRef = useRef(save);
  saveRef.current = save;
  const mounted = useRef(true);
  const queue = useRef<ReturnType<typeof createAutosaveQueue<T>> | null>(null);
  queue.current ??= createAutosaveQueue<T>((next, superseded) => saveRef.current(next, superseded), (nextState, nextError) => {
    if (mounted.current) { setState(nextState); setError(nextError); }
  }, delayMs);
  const json = JSON.stringify(value);

  useLayoutEffect(() => {
    if (loaded) queue.current!.observe(value);
  }, [json, loaded]);

  useEffect(() => {
    mounted.current = true;
    const flush = () => { void queue.current!.handoff(); };
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      mounted.current = false;
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();
      queue.current!.dispose();
    };
  }, []);

  return { state, error, retry: () => { void queue.current!.flush(); } };
}
