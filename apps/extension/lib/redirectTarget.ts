import type { FetchLike, RedirectTarget } from '@kiwi-search/core';

/** What `webRequest.onBeforeRedirect` tells about a redirect that is about to be followed. */
export interface RedirectDetails {
  requestId: string;
  /** The address that answered with the redirect. */
  url: string;
  /** Where it sends the request next. */
  redirectUrl: string;
  /** -1 for a request the extension itself made, not one of a page. */
  tabId: number;
}

/** The part of `browser.webRequest.onBeforeRedirect` that is used, so a test can stand in for it. */
export interface RedirectEvents {
  addListener(listener: (details: RedirectDetails) => void, filter: { urls: string[]; tabId?: number }): void;
  removeListener(listener: (details: RedirectDetails) => void): void;
}

function sameAddress(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return false;
  }
}

/**
 * Finds where a link is redirected to without waiting for the page it is redirected to.
 *
 * `fetch` follows a redirect and only answers once the destination does. A slow destination ran into the timeout, and one that
 * answered a request with no cookies with a 401 or 403 (news sites, anything behind a bot check) was taken for a failure, though Google
 * had already named the address. The redirect is therefore read from `webRequest.onBeforeRedirect` and the request is aborted at once:
 * the request to the destination is cancelled about a millisecond after it starts (2026-11-14, see sources.md).
 *
 * The first redirect that changes the host is the answer. Redirects that stay on the host are followed. Where nothing was observed
 * (no listener could be added, or the browser does not report the redirect) the address `fetch` ended at is used when it differs from
 * the start, as before.
 */
export function createRedirectTarget(deps: { onBeforeRedirect: RedirectEvents; fetch: FetchLike }): RedirectTarget {
  return async (url, signal) => {
    if (signal.aborted) return undefined;
    let start: URL;
    try {
      start = new URL(url);
    } catch {
      return undefined;
    }

    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });

    let requestId: string | undefined;
    let target: string | undefined;
    const listener = (details: RedirectDetails) => {
      if (target !== undefined || details.tabId !== -1) return;
      // The first redirect belongs to the address that was asked for; the ones after it share its request id.
      if (requestId === undefined) {
        if (!sameAddress(details.url, start.href)) return;
        requestId = details.requestId;
      } else if (details.requestId !== requestId) return;
      try {
        const next = new URL(details.redirectUrl);
        if (next.hostname === start.hostname) return;
        target = next.href;
      } catch {
        return;
      }
      controller.abort();
    };

    let listening = false;
    try {
      deps.onBeforeRedirect.addListener(listener, { urls: [`${start.origin}/*`], tabId: -1 });
      listening = true;
    } catch {
      // No webRequest (the permission is missing, or the browser has none): the fetch below still tells where it ended.
    }

    try {
      const response = await deps.fetch(start.href, { signal: controller.signal });
      // The page itself is not wanted; do not download it.
      void response.body?.cancel().catch(() => {});
      if (target === undefined && response.redirected) {
        const ended = new URL(response.url);
        if (ended.hostname !== start.hostname) target = ended.href;
      }
    } catch {
      // Aborted by this function once the redirect was seen, aborted by the caller, or the network failed. Only `target` matters.
    } finally {
      if (listening) {
        try {
          deps.onBeforeRedirect.removeListener(listener);
        } catch {
          // Nothing left to undo.
        }
      }
      signal.removeEventListener('abort', abort);
    }
    return target;
  };
}
