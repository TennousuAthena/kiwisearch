import type { FetchLike } from './types';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(fetch: FetchLike, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(res.status, `HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function fetchText(fetch: FetchLike, url: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, init);
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
  return res.text();
}

export function withTimeout(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${ms}ms`)), ms);
  const onAbort = () => ctrl.abort(parent?.reason);
  parent?.addEventListener('abort', onAbort, { once: true });
  if (parent?.aborted) ctrl.abort(parent.reason);
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
