// @vitest-environment happy-dom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { watchAddress } from '../src/address';
import { ConnectionPanel } from '../src/ConnectionPanel';
import { reloadIfLinkDiedWhileAway } from '../src/restore';

const memory = () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} });

describe('the fallback screen follows the address', () => {
  it('starts a new panel for a new search, so the box and the links follow it', () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    const show = (query: string) => flushSync(() => root.render(<ConnectionPanel key={query} state="missing" query={query} store={memory()} />));
    show('cats');
    expect(host.querySelector('input')!.value).toBe('cats');
    expect(host.querySelector<HTMLAnchorElement>('.panel-engines a')!.href).toContain('q=cats');
    show('dogs');
    expect(host.querySelector('input')!.value).toBe('dogs');
    expect(host.querySelector<HTMLAnchorElement>('.panel-engines a')!.href).toContain('q=dogs');
    root.unmount();
  });

  it('hears a change of the fragment and of the history entry, and can stop listening', () => {
    const listener = vi.fn();
    const stop = watchAddress(window, listener);
    window.dispatchEvent(new Event('hashchange'));
    window.dispatchEvent(new Event('popstate'));
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new Event('hashchange'));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('a page restored from the back-forward cache', () => {
  const setup = (request: () => Promise<unknown>) => {
    const listeners: Array<(event: { persisted: boolean }) => void> = [];
    const win = { addEventListener: (_: string, l: (e: never) => void) => { listeners.push(l as never); }, location: { reload: vi.fn() } };
    reloadIfLinkDiedWhileAway(win as never, { request: request as never }, 20);
    return { win, show: (persisted: boolean) => listeners.forEach((l) => l({ persisted })) };
  };

  it('keeps going when its link to the extension still answers', async () => {
    const { win, show } = setup(() => Promise.resolve({ values: {} }));
    show(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(win.location.reload).not.toHaveBeenCalled();
  });

  it('loads again when the link no longer answers, which makes a new one', async () => {
    const { win, show } = setup(() => Promise.reject(new Error('timeout')));
    show(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it('asks nothing of a page that is just shown', async () => {
    const request = vi.fn(() => Promise.reject(new Error('x')));
    const { win, show } = setup(request);
    show(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(request).not.toHaveBeenCalled();
    expect(win.location.reload).not.toHaveBeenCalled();
  });
});
