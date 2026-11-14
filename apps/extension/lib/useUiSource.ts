import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { parseUiSource, UI_FALLBACK_KEY, UI_SOURCE_KEY, type UiSource } from './uiSource';

/** The interface source and the fallback switch, kept in step with `storage` (the settings page and the service worker both read them). */
export function useUiSource() {
  const [state, setState] = useState<{ source: UiSource; fallback: boolean; ready: boolean }>({ source: 'site', fallback: false, ready: false });
  useEffect(() => {
    let live = true;
    void browser.storage.local.get([UI_SOURCE_KEY, UI_FALLBACK_KEY]).then((values) => {
      if (live) setState({ source: parseUiSource(values[UI_SOURCE_KEY]), fallback: values[UI_FALLBACK_KEY] === true, ready: true });
    });
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      setState((current) => ({
        ...current,
        ...(changes[UI_SOURCE_KEY] ? { source: parseUiSource(changes[UI_SOURCE_KEY].newValue) } : {}),
        ...(changes[UI_FALLBACK_KEY] ? { fallback: changes[UI_FALLBACK_KEY].newValue === true } : {}),
      }));
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => { live = false; browser.storage.onChanged.removeListener(onChanged); };
  }, []);
  return state;
}
