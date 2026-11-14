// @vitest-environment happy-dom
import { createBridgeRelay } from '@kiwi-search/protocol';
import { describe, expect, it } from 'vitest';
import { establish, readMarker, waitForMarker } from '../src/connection';

/** A window whose `postMessage` hands the transferred port to the test, as the content script would take it. */
function fakeWindow() {
  const taken: MessagePort[] = [];
  const win = { location: { origin: 'https://kiwi.moe' }, postMessage: (_message: unknown, _origin: string, transfer: MessagePort[]) => { taken.push(...transfer); } } as unknown as Window;
  return { win, taken };
}
const marked = () => { const doc = document.implementation.createHTMLDocument('x'); doc.documentElement.dataset.kiwi = '1'; return doc; };

describe('finding the extension', () => {
  it('sees the mark the content script leaves before the page runs', async () => {
    const doc = marked();
    expect(readMarker(doc)).toBe('1');
    expect(await waitForMarker(doc)).toBe(true);
  });

  it('waits a moment for a browser that injects late, and then gives up', async () => {
    const late = document.implementation.createHTMLDocument('x');
    setTimeout(() => { late.documentElement.dataset.kiwi = '1'; }, 20);
    expect(await waitForMarker(late, 200)).toBe(true);
    expect(await waitForMarker(document.implementation.createHTMLDocument('y'), 30)).toBe(false);
  });

  it('is "missing" when nothing marks the page', async () => {
    const { win, taken } = fakeWindow();
    const doc = document.implementation.createHTMLDocument('x');
    // The default wait is 300 ms; the document stays unmarked.
    expect(await establish(win, doc)).toEqual({ state: 'missing' });
    expect(taken).toEqual([]);
  });
});

describe('the handshake as the page sees it', () => {
  async function connectTo(hello: () => Promise<{ state: 'ok'; ext: string; caps: string[] } | { state: 'disabled' }>) {
    const { win, taken } = fakeWindow();
    const connecting = establish(win, marked());
    await new Promise((r) => setTimeout(r, 10));
    const relay = createBridgeRelay(taken[0], { hello, request: async () => ({}), openStream: () => { throw new Error('none'); } });
    return { result: await connecting, relay };
  }

  it('is ready with the extension version and what it can do', async () => {
    const { result, relay } = await connectTo(async () => ({ state: 'ok', ext: '0.1.0', caps: ['favicon'] }));
    expect(result).toMatchObject({ state: 'ready', ext: '0.1.0', caps: ['favicon'] });
    relay.close();
  });

  it('is "disabled" when the extension is set to use its own interface', async () => {
    const { result, relay } = await connectTo(async () => ({ state: 'disabled' }));
    expect(result).toEqual({ state: 'disabled' });
    relay.close();
  });

  it('is "unavailable" when the service worker does not answer', async () => {
    const { result, relay } = await connectTo(() => Promise.reject(new Error('gone')));
    expect(result).toEqual({ state: 'unavailable' });
    relay.close();
  });

  it('tells an old extension from an old page by the protocol numbers the extension supports', async () => {
    for (const [protocols, pageIsOld] of [[[2, 3], true], [[0], false], [[], false]] as const) {
      const { win, taken } = fakeWindow();
      const connecting = establish(win, marked());
      await new Promise((r) => setTimeout(r, 10));
      taken[0].onmessage = (event) => { if (event.data.t === 'hello') taken[0].postMessage({ t: 'incompatible', protocols }); };
      expect(await connecting, JSON.stringify(protocols)).toMatchObject({ state: 'incompatible', pageIsOld });
      taken[0].close();
    }
  });
});
