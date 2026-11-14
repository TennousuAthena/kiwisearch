import type { FetchLike } from '@kiwi-search/core';
import { describe, expect, it, vi } from 'vitest';
import { createRedirectTarget, type RedirectDetails, type RedirectEvents } from '../lib/redirectTarget';

const WRAPPER = 'https://www.google.com/goto?url=opaque-token';
const redirect = (patch: Partial<RedirectDetails> = {}): RedirectDetails => ({
  requestId: '7',
  url: WRAPPER,
  redirectUrl: 'https://www.reuters.com/world/story/',
  tabId: -1,
  ...patch,
});

/** A stand-in for `browser.webRequest.onBeforeRedirect` that remembers what was asked of it. */
function fakeEvents() {
  const listeners = new Set<(details: RedirectDetails) => void>();
  const filters: { urls: string[]; tabId?: number }[] = [];
  const events: RedirectEvents & { fire(details: RedirectDetails): void; listeners: typeof listeners; filters: typeof filters } = {
    listeners,
    filters,
    addListener(listener, filter) {
      listeners.add(listener);
      filters.push(filter);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    fire(details) {
      for (const listener of [...listeners]) listener(details);
    },
  };
  return events;
}

/** A request that never gets an answer, as when the destination is slow: it only ends when it is aborted. `onRequest` plays Google's redirect. */
function hangingFetch(onRequest: (url: string) => void) {
  const state = { aborted: false, calls: 0 };
  const fetch: FetchLike = (url, init) =>
    new Promise((_, reject) => {
      state.calls++;
      init?.signal?.addEventListener('abort', () => {
        state.aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
      queueMicrotask(() => onRequest(url));
    });
  return { fetch, state };
}

function answer(url: string, { redirected = true, status = 200 } = {}): Response {
  const response = new Response('<html>the page</html>', { status });
  Object.defineProperty(response, 'url', { value: url });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
}

describe('createRedirectTarget', () => {
  it('answers with the first redirect that leaves the host and aborts the request at once, without waiting for the page', async () => {
    const events = fakeEvents();
    const { fetch, state } = hangingFetch(() => events.fire(redirect()));
    const target = await createRedirectTarget({ onBeforeRedirect: events, fetch })(WRAPPER, new AbortController().signal);
    expect(target).toBe('https://www.reuters.com/world/story/');
    expect(state.aborted).toBe(true);
  });

  it('follows redirects that stay on the host, then answers with the one that leaves it', async () => {
    const events = fakeEvents();
    const { fetch, state } = hangingFetch(() => {
      events.fire(redirect({ redirectUrl: 'https://www.google.com/goto?url=second-hop' }));
      expect(state.aborted).toBe(false);
      events.fire(redirect({ url: 'https://www.google.com/goto?url=second-hop', redirectUrl: 'https://theconversation.com/article' }));
    });
    const target = await createRedirectTarget({ onBeforeRedirect: events, fetch })(WRAPPER, new AbortController().signal);
    expect(target).toBe('https://theconversation.com/article');
  });

  it('ignores the redirects of other requests, of pages, and of other addresses', async () => {
    const events = fakeEvents();
    const { fetch } = hangingFetch(() => {
      events.fire(redirect({ url: 'https://www.google.com/goto?url=someone-elses', requestId: '3', redirectUrl: 'https://wrong.example/one' }));
      events.fire(redirect({ tabId: 42, redirectUrl: 'https://wrong.example/two' }));
      // This one is the request's own (its address is the one asked for) but leads nowhere usable; from here on only its id counts.
      events.fire(redirect({ redirectUrl: 'not an address' }));
      events.fire(redirect({ requestId: '8', url: 'https://www.google.com/goto?url=later', redirectUrl: 'https://wrong.example/three' }));
      events.fire(redirect({ requestId: '7', redirectUrl: 'https://right.example/answer' }));
    });
    const target = await createRedirectTarget({ onBeforeRedirect: events, fetch })(WRAPPER, new AbortController().signal);
    expect(target).toBe('https://right.example/answer');
  });

  it('listens only for the redirects of requests the extension made itself, on the link\'s own origin', async () => {
    const events = fakeEvents();
    const own = 'https://www.google.com.hk/goto?url=x';
    const { fetch } = hangingFetch(() => events.fire(redirect({ url: own })));
    await createRedirectTarget({ onBeforeRedirect: events, fetch })(own, new AbortController().signal);
    expect(events.filters).toEqual([{ urls: ['https://www.google.com.hk/*'], tabId: -1 }]);
  });

  it('takes its listener off again whatever happens', async () => {
    const events = fakeEvents();
    const find = createRedirectTarget({ onBeforeRedirect: events, fetch: hangingFetch(() => events.fire(redirect())).fetch });
    await find(WRAPPER, new AbortController().signal);
    expect(events.listeners.size).toBe(0);

    const failing = createRedirectTarget({ onBeforeRedirect: events, fetch: async () => { throw new Error('network error'); } });
    expect(await failing(WRAPPER, new AbortController().signal)).toBeUndefined();
    expect(events.listeners.size).toBe(0);

    const caller = new AbortController();
    const waiting = createRedirectTarget({ onBeforeRedirect: events, fetch: hangingFetch(() => caller.abort()).fetch });
    expect(await waiting(WRAPPER, caller.signal)).toBeUndefined();
    expect(events.listeners.size).toBe(0);
  });

  it('gives up without a request when the search is already aborted, and aborts the request when it is aborted meanwhile', async () => {
    const events = fakeEvents();
    const aborted = new AbortController();
    aborted.abort();
    const never = vi.fn();
    expect(await createRedirectTarget({ onBeforeRedirect: events, fetch: never })(WRAPPER, aborted.signal)).toBeUndefined();
    expect(never).not.toHaveBeenCalled();
    expect(events.listeners.size).toBe(0);

    const caller = new AbortController();
    const { fetch, state } = hangingFetch(() => caller.abort());
    expect(await createRedirectTarget({ onBeforeRedirect: events, fetch })(WRAPPER, caller.signal)).toBeUndefined();
    expect(state.aborted).toBe(true);
  });

  it('uses the address the fetch ended at when no redirect was reported, and does not download the page', async () => {
    const events = fakeEvents();
    const page = answer('https://www.wsj.com/articles/story', { status: 401 });
    const cancel = vi.spyOn(page.body!, 'cancel');
    const target = await createRedirectTarget({ onBeforeRedirect: events, fetch: async () => page })(WRAPPER, new AbortController().signal);
    expect(target).toBe('https://www.wsj.com/articles/story');
    expect(cancel).toHaveBeenCalled();
    expect(events.listeners.size).toBe(0);
  });

  it('still works when no listener can be added (no webRequest permission)', async () => {
    const events = fakeEvents();
    events.addListener = () => { throw new Error('webRequest is not available'); };
    const removed = vi.spyOn(events, 'removeListener');
    const target = await createRedirectTarget({ onBeforeRedirect: events, fetch: async () => answer('https://example.com/story') })(WRAPPER, new AbortController().signal);
    expect(target).toBe('https://example.com/story');
    expect(removed).not.toHaveBeenCalled();
  });

  it('answers undefined when nothing redirects the link off its host', async () => {
    const events = fakeEvents();
    const find = (response: Response) => createRedirectTarget({ onBeforeRedirect: events, fetch: async () => response })(WRAPPER, new AbortController().signal);
    expect(await find(answer(WRAPPER, { redirected: false }))).toBeUndefined();
    expect(await find(answer('https://www.google.com/sorry/index?continue=x'))).toBeUndefined();
    expect(await find(answer(''))).toBeUndefined();
    expect(await createRedirectTarget({ onBeforeRedirect: events, fetch: async () => answer(WRAPPER) })('not an address', new AbortController().signal)).toBeUndefined();
  });
});
