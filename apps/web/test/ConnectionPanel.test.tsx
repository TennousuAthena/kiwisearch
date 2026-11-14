import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConnectionPanel, INSTALL_URL, type PanelState } from '../src/ConnectionPanel';

const store = () => { const data = new Map<string, string>(); return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } }; };
const render = (state: PanelState, query = 'a&b c', extra: Partial<Parameters<typeof ConnectionPanel>[0]> = {}) => renderToStaticMarkup(<ConnectionPanel state={state} query={query} store={store()} {...extra} />);

describe('what the page shows without a working extension', () => {
  it('keeps the query in the box and offers install, and other engines as plain links with the query escaped', () => {
    const html = render('missing');
    expect(html).toContain('value="a&amp;b c"');
    expect(html).toContain(`href="${INSTALL_URL}"`);
    expect(html).toContain('href="https://www.google.com/search?q=a%26b%20c"');
    expect(html).toContain('href="https://www.baidu.com/s?wd=a%26b%20c"');
    // Nothing is sent anywhere until a link is clicked: the engines are anchors, not a form that submits.
    expect(html).not.toContain('action=');
  });

  it('offers the local interface when the extension is the old side, only if the page can ask for it', () => {
    expect(render('incompatible', 'x', { onOpenLocal: () => {} })).toContain('<button');
    expect(render('incompatible', 'x')).not.toContain('<button type="button" class="btn">');
    expect(render('incompatible', 'x')).toContain(`href="${INSTALL_URL}"`);
  });

  it('shows how to open the extension\'s own interface when the extension is set to use it, and no other engines', () => {
    const html = render('disabled');
    expect(html).toContain('地址栏');
    expect(html).not.toContain('google.com');
    expect(html).not.toContain('checkbox');
  });

  it('asks only for a reload when the page is the old side, and offers no other engines', () => {
    const html = render('stale');
    expect(html).toContain('<button');
    expect(html).not.toContain('google.com');
  });

  it('offers a reload and the other engines when the extension did not answer', () => {
    const html = render('unavailable');
    expect(html).toContain('<button');
    expect(html).toContain('google.com');
  });

  it('shows the remembered engine and a way to take it back', () => {
    const s = store(); s.setItem('kiwi:fallbackEngine', 'duckduckgo');
    const html = renderToStaticMarkup(<ConnectionPanel state="missing" query="q" store={s} />);
    expect(html).toContain('DuckDuckGo');
  });
});

describe('when the browser blocks website storage', () => {
  it('still shows the install screen and the engines (naming `localStorage` throws there)', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
      const html = renderToStaticMarkup(<ConnectionPanel state="missing" query="q" />);
      expect(html).toContain(`href="${INSTALL_URL}"`);
      expect(html).toContain('google.com');
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
