import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ send: vi.fn(), extract: vi.fn() }));
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: mock.send } } }));
vi.mock('@kiwi-search/core', () => ({ BROWSER_ENGINES: { amazon: {
  readySelector: '#ready', blockedSelector: '#blocked', loginSelector: '#login', minTimeoutMs: 60_000, extract: mock.extract,
} } }));
import { runEngineContent } from '../lib/engineContent';

let change: () => void;
let ready = false;
let login = false;
let observed: unknown;
const disconnect = vi.fn();
const extracted = () => mock.send.mock.calls.filter(([message]) => message.type === 'kiwi:extracted');

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  ready = false;
  login = false;
  observed = undefined;
  mock.send.mockImplementation(async ({ type }) => type === 'kiwi:worker?' ? { type: 'kiwi:worker!', engine: 'amazon', requestId: 'request', count: 1, mode: 'shopping' } : { ok: true });
  mock.extract.mockImplementation(() => ready ? [{ url: 'https://www.amazon.com/dp/B005EPRFKO', title: 'Product', snippet: '', rank: 1 }] : []);
  vi.stubGlobal('document', { documentElement: null, body: null, querySelector: (selector: string) => (selector === '#ready' && ready) || (selector === '#login' && login) ? {} : null });
  vi.stubGlobal('location', { href: 'https://www.amazon.com/s?k=coffee' });
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { change = callback; }
    observe(target: unknown) { observed = target; }
    disconnect = disconnect;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('shopping content startup', () => {
  it('does not observe or extract an ordinary user tab', async () => {
    mock.send.mockResolvedValue({ type: 'kiwi:not-worker' });
    await runEngineContent({ early: true });
    expect(observed).toBeUndefined();
    expect(mock.extract).not.toHaveBeenCalled();
  });

  it('keeps the existing immediate completion for ordinary engine pages', async () => {
    ready = true;
    const root = {};
    Object.assign(document, { documentElement: root });
    await runEngineContent();
    expect(observed).toBe(root);
    expect(extracted()).toHaveLength(1);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('reads streamed products before documentElement or document_idle exists, after fields settle', async () => {
    await runEngineContent({ early: true });
    expect(observed).toBe(document);
    ready = true;
    change();
    await vi.advanceTimersByTimeAsync(120);
    expect(extracted()).toHaveLength(0);
    mock.extract.mockReturnValue([{ url: 'https://www.amazon.com/dp/B005EPRFKO', title: 'Product', snippet: '', rank: 1, product: { price: 'GBP 15.13' } }]);
    change();
    await vi.advanceTimersByTimeAsync(720);
    expect(extracted()).toHaveLength(1);
    expect(extracted()[0][0].hits[0].product.price).toBe('GBP 15.13');
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('reports a login wall instead of prematurely finishing with no products', async () => {
    await runEngineContent({ early: true });
    login = true;
    change();
    await vi.advanceTimersByTimeAsync(120);
    expect(mock.send).toHaveBeenCalledWith({ type: 'kiwi:blocked', requestId: 'request', reason: 'login' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(extracted()).toHaveLength(0);
  });

  it('allows a slow Amazon document to stream products past the usual page deadline', async () => {
    await runEngineContent({ early: true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(extracted()).toHaveLength(0);
    ready = true;
    change();
    await vi.advanceTimersByTimeAsync(720);
    expect(extracted()).toHaveLength(1);
  });
});
