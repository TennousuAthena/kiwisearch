import type { FetchLike } from './types';

/**
 * OpenCode's gateway (`opencode.ai`, both its Go and Zen lanes). Since 2026-09-06 the Go lane answers HTTP 400 `MissingSessionID`
 * to a request without an `x-opencode-session` header, and its documentation asks a client to send one stable id for each
 * conversation; the id is only a routing and prompt-cache hint, not a credential. Zen ignores it.
 */
const OPENCODE_HOST = /(^|\.)opencode\.ai$/i;

/** Whether a model request goes to OpenCode's gateway. */
export function isOpenCodeUrl(url: string): boolean {
  try {
    return OPENCODE_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** `ses_` and 32 lowercase hex digits, the shape OpenCode's own tools use. The gateway treats the value as opaque. */
export function newSessionId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `ses_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A `fetch` that adds the headers a model gateway requires and the user could not be expected to know about. Everything else, and
 * every other host, passes through untouched. One call of this is one conversation: all requests through the result share one
 * session id, made when the first of them needs it, and the next call makes a new one. The caller makes one per search, so the
 * decision model, the judge and the overview of one search are one conversation to the gateway. A header the caller set is kept.
 */
export function withGatewayHeaders(fetch: FetchLike, makeSessionId: () => string = newSessionId): FetchLike {
  let sessionId: string | undefined;
  return (input, init) => {
    if (!isOpenCodeUrl(input)) return fetch(input, init);
    const headers = new Headers(init?.headers);
    if (!headers.has('x-opencode-session')) headers.set('x-opencode-session', (sessionId ??= makeSessionId()));
    return fetch(input, { ...init, headers });
  };
}
