import { useEffect, useRef, useState } from 'react';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Saves `value` a moment after it last changed. The value `loaded` as is never written back, so opening the page changes
 * nothing; a failed write is reported and retried with the next change. Closing or hiding the tab inside the delay writes at once.
 */
export function useAutosave<T>(value: T, loaded: boolean, save: (value: T) => Promise<void>, delayMs = 500): { state: SaveState; error: string } {
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState('');
  const lastSaved = useRef<string | null>(null);
  const pending = useRef<{ value: T; json: string } | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;

  const write = useRef((next: { value: T; json: string }) => {
    pending.current = null;
    return saveRef
      .current(next.value)
      .then(() => {
        lastSaved.current = next.json;
        setState('saved');
        setError('');
      })
      .catch((e: unknown) => {
        setState('error');
        setError(e instanceof Error ? e.message : String(e));
      });
  });

  useEffect(() => {
    if (!loaded) return;
    const json = JSON.stringify(value);
    if (lastSaved.current === null) {
      lastSaved.current = json;
      return;
    }
    if (json === lastSaved.current) {
      pending.current = null;
      return;
    }
    setState('saving');
    pending.current = { value, json };
    const timer = setTimeout(() => void write.current({ value, json }), delayMs);
    return () => clearTimeout(timer);
  }, [value, loaded, delayMs]);

  useEffect(() => {
    const flush = () => {
      if (pending.current) void write.current(pending.current);
    };
    const onHide = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, []);

  return { state, error };
}
