// @vitest-environment happy-dom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstallOptions } from '../src/InstallOptions';
import { detectBrowser, RELEASES_URL, STORE_URLS, storeForBrowser } from '../src/installation';

afterEach(() => { vi.unstubAllGlobals(); });

describe('choosing an installation destination', () => {
  it.each([
    ['Mozilla/5.0 Chrome/156.0 Safari/537.36', 'chrome', 'chrome'],
    ['Mozilla/5.0 Chrome/156.0 Safari/537.36 Edg/156.0', 'edge', 'edge'],
    ['Mozilla/5.0 Firefox/160.0', 'firefox', 'firefox'],
    ['Mozilla/5.0 Chrome/156.0 OPR/120.0', 'opera', 'chrome'],
    ['Mozilla/5.0 Chromium/156.0', 'chromium', 'chrome'],
    ['Mozilla/5.0 Macintosh Version/18.0 Safari/605.1.15', null, null],
    ['Mozilla/5.0 Android Chrome/156.0 Mobile Safari/537.36', null, null],
    ['Mozilla/5.0 iPhone CriOS/156.0 Mobile Safari/604.1', null, null],
    ['Mozilla/5.0 iPad FxiOS/150.0 Mobile', null, null],
  ] as const)('routes %s without confusing it with a different store', (userAgent, browser, store) => {
    const detected = detectBrowser({ userAgent });
    expect(detected).toBe(browser);
    expect(detected && storeForBrowser(detected)).toBe(store);
  });

  it('uses brand hints before the generic Chrome token and recognizes desktop-mode iPads', () => {
    expect(detectBrowser({ userAgent: 'Chrome/156.0', userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Brave' }] } })).toBe('brave');
    expect(detectBrowser({ userAgent: 'Chrome/156.0', userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }] } })).toBe('edge');
    expect(detectBrowser({ userAgent: 'Macintosh Safari/605.1.15', maxTouchPoints: 5 })).toBeNull();
  });

  it('keeps unpublished stores inert and the release index reachable', () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/156.0 Edg/156.0' });
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      flushSync(() => root.render(<InstallOptions />));
      expect(host.querySelector('select')!.value).toBe('edge');
      expect(host.querySelector('.install-store a')).toBeNull();
      expect(host.querySelector<HTMLButtonElement>('.install-store button')!.disabled).toBe(true);
      expect(host.querySelector<HTMLAnchorElement>('a')!.href).toBe(RELEASES_URL);
      expect(host.textContent).toContain('安装包尚未发布');
    } finally { root.unmount(); }
  });

  it('enables a published listing and switches destinations when the browser choice changes', () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/156.0 Edg/156.0' });
    const before = { ...STORE_URLS };
    STORE_URLS.edge = 'https://microsoftedge.microsoft.com/addons/detail/test-listing';
    STORE_URLS.firefox = 'https://addons.mozilla.org/firefox/addon/test-listing/';
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      flushSync(() => root.render(<InstallOptions />));
      expect(host.querySelector<HTMLAnchorElement>('.install-store a')!.href).toBe(STORE_URLS.edge);
      const select = host.querySelector('select')!;
      flushSync(() => { select.value = 'firefox'; select.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(host.querySelector<HTMLAnchorElement>('.install-store a')!.href).toBe(STORE_URLS.firefox);
      expect(host.textContent).toContain('添加到 Firefox');
      flushSync(() => { select.value = 'chrome'; select.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(host.querySelector('.install-store a')).toBeNull();
      expect(host.querySelector<HTMLButtonElement>('.install-store button')!.disabled).toBe(true);
    } finally { root.unmount(); Object.assign(STORE_URLS, before); }
  });

  it('asks unknown browsers to choose instead of advertising a Chrome install', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh Version/18.0 Safari/605.1.15' });
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      flushSync(() => root.render(<InstallOptions />));
      expect(host.querySelector('select')!.value).toBe('');
      expect(host.textContent).toContain('请选择要安装扩展的桌面浏览器');
      expect(host.querySelector('.install-store a')).toBeNull();
    } finally { root.unmount(); }
  });
});
