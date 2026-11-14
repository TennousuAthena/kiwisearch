import { browser } from 'wxt/browser';

/** Where the search interface comes from: the website (`site`, the default) or the extension's own page (`local`). */
export type UiSource = 'site' | 'local';

export const UI_SOURCE_KEY = 'uiSource';
/** Whether a website that cannot be reached sends the user to the extension's own interface (needs an optional permission). */
export const UI_FALLBACK_KEY = 'uiFallback';

export const parseUiSource = (value: unknown): UiSource => (value === 'local' ? 'local' : 'site');

export async function loadUiSource(): Promise<UiSource> {
  return parseUiSource((await browser.storage.local.get(UI_SOURCE_KEY))[UI_SOURCE_KEY]);
}

export async function loadUiFallback(): Promise<boolean> {
  return (await browser.storage.local.get(UI_FALLBACK_KEY))[UI_FALLBACK_KEY] === true;
}
