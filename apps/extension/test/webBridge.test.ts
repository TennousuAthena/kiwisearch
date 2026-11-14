import { SEARCH_MODES as CORE_MODES } from '@kiwi-search/core';
import { SEARCH_MODES, WEB_METHODS } from '@kiwi-search/protocol';
import { describe, expect, it, vi } from 'vitest';
import { localSearchUrl, siteSearchUrl } from '../lib/localUrl';
import { answer, createWebBridgeHandlers, isWebBridgeSender, WebRequestError, type WebBridgeDeps } from '../lib/webBridge';

const ID = 'ext-id';
const SITES = [{ origin: 'https://kiwi.moe', paths: ['/'] }] as const;
const site = { id: ID, url: 'https://kiwi.moe/#q=x', tab: { id: 7 }, frameId: 0 };

function setup(patch: Partial<WebBridgeDeps> = {}) {
  let source: 'site' | 'local' = 'site';
  let clock = 0;
  const deps = {
    extensionId: ID, version: '1.2.3', sites: SITES,
    uiSource: vi.fn(async () => source),
    favicon: vi.fn(async (host: string) => `data:${host}`),
    focusWorker: vi.fn(async () => true),
    updateSettings: vi.fn(async (message: unknown) => ({ ok: true as const, undo: { domain: 'a.com', before: { blocked: false, boosted: false }, after: { blocked: true, boosted: false }, revision: 'r' }, restored: true, message })),
    loadPreferences: vi.fn(async () => ({ 'ui:theme': 'dark' })),
    savePreferences: vi.fn(async () => {}),
    loadAcademicLanguage: vi.fn(async () => 'any' as const),
    saveAcademicLanguage: vi.fn(async () => {}),
    openLocal: vi.fn(async () => {}),
    openOptions: vi.fn(async () => {}),
    now: () => clock,
    ...patch,
  } satisfies WebBridgeDeps;
  return { handlers: createWebBridgeHandlers(deps), deps, useLocal: () => { source = 'local'; }, tick: (ms: number) => { clock += ms; } };
}

describe('who counts as the website', () => {
  it('accepts only our content script in the top frame of the search page of the website, in a tab', () => {
    expect(isWebBridgeSender(site, ID, SITES)).toBe(true);
    expect(isWebBridgeSender({ ...site, frameId: undefined }, ID, SITES)).toBe(true);
    for (const bad of [undefined, { ...site, id: 'other' }, { ...site, url: 'https://evil.example/' }, { ...site, url: 'https://kiwi.moe.evil.example/' },
      { ...site, url: 'https://s.kiwi.moe/' }, { ...site, url: 'https://kiwi.moe/install' }, { ...site, url: 'https://kiwi.moe/privacy' }, { ...site, url: 'http://kiwi.moe/' }, { ...site, url: 'not a url' }, { ...site, url: undefined }, { ...site, tab: undefined }, { ...site, frameId: 3 },
      { id: ID, url: `chrome-extension://${ID}/app.html`, tab: { id: 1 } }]) {
      expect(isWebBridgeSender(bad, ID, SITES), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('a development build', () => {
  it('lets every path of its one extra origin use the bridge, and still only the root of the real site', () => {
    const sites = [...SITES, { origin: 'http://localhost:5173', paths: null }];
    expect(isWebBridgeSender({ ...site, url: 'http://localhost:5173/any/page.html' }, ID, sites)).toBe(true);
    expect(isWebBridgeSender({ ...site, url: 'http://localhost:9999/' }, ID, sites)).toBe(false);
    expect(isWebBridgeSender({ ...site, url: 'https://kiwi.moe/install' }, ID, sites)).toBe(false);
  });
});

describe('the handshake', () => {
  it('tells the page the extension version and what it can do, while the extension uses the website', async () => {
    const { handlers } = setup();
    expect(await handlers.hello(site)).toMatchObject({ state: 'ok', ext: '1.2.3' });
    expect((await handlers.hello(site) as { caps: string[] }).caps).toEqual(expect.arrayContaining(['favicon', 'openLocal', 'stream:search']));
  });

  it('says disabled when the extension is set to use its own interface, and then refuses everything', async () => {
    const { handlers, useLocal, deps } = setup();
    useLocal();
    expect(await handlers.hello(site)).toEqual({ state: 'disabled' });
    expect(await handlers.allowed(site)).toBe(false);
    await expect(handlers.request('favicon', { host: 'a.com' }, site)).rejects.toMatchObject({ code: 'forbidden' });
    expect(deps.favicon).not.toHaveBeenCalled();
  });

  it('does not answer anyone but the website', async () => {
    const { handlers } = setup();
    await expect(handlers.hello({ ...site, url: 'https://evil.example/' })).rejects.toBeInstanceOf(WebRequestError);
    await expect(handlers.request('favicon', { host: 'a.com' }, undefined)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('requests', () => {
  it('serves a site icon', async () => {
    const { handlers, deps } = setup();
    expect(await handlers.request('favicon', { host: 'example.com' }, site)).toEqual({ src: 'data:example.com' });
    expect(deps.favicon).toHaveBeenCalledWith('example.com');
  });

  it('refuses an unknown method and a request of the wrong form without touching anything', async () => {
    const { handlers, deps } = setup();
    for (const method of ['update-settings', 'config.load', 'test-llm', 'bridge', 42, undefined]) {
      await expect(handlers.request(method, {}, site), String(method)).rejects.toMatchObject({ code: 'unknown_method' });
    }
    await expect(handlers.request('favicon', { host: 'a.com/x' }, site)).rejects.toMatchObject({ code: 'invalid' });
    await expect(handlers.request('prefs.save', { values: { config: { llm: { apiKey: 'x' } } } }, site)).rejects.toMatchObject({ code: 'invalid' });
    await expect(handlers.request('focusWorker', { source: '../x' }, site)).rejects.toMatchObject({ code: 'invalid' });
    const actions = [deps.favicon, deps.focusWorker, deps.updateSettings, deps.loadPreferences, deps.savePreferences, deps.loadAcademicLanguage, deps.saveAcademicLanguage, deps.openLocal, deps.openOptions];
    for (const action of actions) expect(action).not.toHaveBeenCalled();
  });

  it('builds the settings update itself: a page can block a site but cannot send a settings patch', async () => {
    const { handlers, deps } = setup();
    const result = await handlers.request('domainPreference', { action: 'block', domain: 'https://www.A.com/x', config: [{ path: ['llm', 'apiKey'], value: 'x' }], bridge: [{ path: ['token'], value: 'y' }] }, site);
    expect(deps.updateSettings).toHaveBeenCalledWith({ type: 'kiwi:update-settings', action: 'block', domain: 'a.com' });
    expect(result).toMatchObject({ undo: { domain: 'a.com' } });
  });

  it('undoes with a rebuilt receipt', async () => {
    const { handlers, deps } = setup();
    const undo = { domain: 'a.com', before: { blocked: false, boosted: false }, after: { blocked: true, boosted: false }, revision: 'r', config: 'x' };
    expect(await handlers.request('undoDomainPreference', { undo }, site)).toEqual({ restored: true });
    expect(deps.updateSettings).toHaveBeenCalledWith({ type: 'kiwi:update-settings', undo: { domain: 'a.com', before: { blocked: false, boosted: false }, after: { blocked: true, boosted: false }, revision: 'r' } });
  });

  it('reports a settings update that did not complete as a refusal', async () => {
    const { handlers } = setup({ updateSettings: async () => ({ ok: false, error: 'Invalid domain' }) });
    await expect(handlers.request('domainPreference', { action: 'block', domain: 'a.com' }, site)).rejects.toMatchObject({ code: 'failed' });
  });

  it('reads and writes the interface preferences and the academic language', async () => {
    const { handlers, deps } = setup();
    expect(await handlers.request('prefs.load', undefined, site)).toEqual({ values: { 'ui:theme': 'dark' } });
    await handlers.request('prefs.save', { values: { 'ui:theme': 'light' } }, site);
    expect(deps.savePreferences).toHaveBeenCalledWith({ 'ui:theme': 'light' });
    expect(await handlers.request('academicLanguage.load', undefined, site)).toEqual({ language: 'any' });
    await handlers.request('academicLanguage.save', { language: 'en' }, site);
    expect(deps.saveAcademicLanguage).toHaveBeenCalledWith('en');
  });

  it('opens a search in the extension in the tab that asked, and the settings page', async () => {
    const { handlers, deps } = setup();
    await handlers.request('openLocal', { query: 'hello', mode: 'images' }, site);
    expect(deps.openLocal).toHaveBeenCalledWith(7, 'hello', 'images');
    await handlers.request('openOptions', { section: 'sources' }, site);
    expect(deps.openOptions).toHaveBeenCalledWith('sources');
  });

  it('limits how fast a page may write', async () => {
    const { handlers, deps, tick } = setup();
    for (let i = 0; i < 30; i++) await handlers.request('academicLanguage.save', { language: 'en' }, site);
    await expect(handlers.request('academicLanguage.save', { language: 'en' }, site)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(handlers.request('prefs.save', { values: { 'ui:theme': 'dark' } }, site)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(deps.saveAcademicLanguage).toHaveBeenCalledTimes(30);
    await expect(handlers.request('favicon', { host: 'a.com' }, site)).resolves.toBeDefined();
    tick(60_001);
    await expect(handlers.request('academicLanguage.save', { language: 'en' }, site)).resolves.toEqual({});
  });
});

describe('what a failure shows the page', () => {
  it('passes on a refusal as it is and hides anything else', async () => {
    expect(await answer(Promise.resolve(5))).toEqual({ ok: true, result: 5 });
    expect(await answer(Promise.reject(new WebRequestError('invalid', 'bad')))).toEqual({ ok: false, error: { code: 'invalid', message: 'bad' } });
    expect(await answer(Promise.reject(new Error('/Users/someone/secret path')))).toEqual({ ok: false, error: { code: 'failed', message: 'The extension could not complete the request' } });
  });
});

describe('the lists shared with core and the address of the local page', () => {
  it('knows the same search modes as core', () => {
    expect([...SEARCH_MODES]).toEqual([...CORE_MODES]);
  });

  it('offers only methods the handlers know', async () => {
    const { handlers } = setup();
    for (const method of WEB_METHODS) {
      // Each method is either served or refuses the empty request as invalid; none is "unknown".
      await handlers.request(method, undefined, site).catch((error: WebRequestError) => expect(error.code).not.toBe('unknown_method'));
    }
  });

  it('writes the address form the website uses, for the extension page and for the website', () => {
    expect(localSearchUrl('chrome-extension://x/app.html', 'hello world', 'web')).toBe('chrome-extension://x/app.html#q=hello%20world');
    expect(localSearchUrl('chrome-extension://x/app.html', 'a&b', 'images')).toBe('chrome-extension://x/app.html#m=images&q=a%26b');
    expect(siteSearchUrl('a&b c', 'news')).toBe('https://kiwi.moe/#m=news&q=a%26b%20c');
  });
});
