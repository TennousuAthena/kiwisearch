import type { PipelineEvent } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { healthFromEvent, type SourceHealthMap } from './sourceHealth';

const KEY = 'sourceStatus';

export async function loadSourceStatus(): Promise<SourceHealthMap> {
  const stored = (await browser.storage.local.get(KEY))[KEY];
  return stored && typeof stored === 'object' ? (stored as SourceHealthMap) : {};
}

/** Read-modify-write through one chain, so a burst of events from one search can't overwrite each other. */
let tail: Promise<void> = Promise.resolve();

/** Remember what a pipeline event says about its source. Cheap and never throws: it must not get in a search's way. */
export function recordSourceStatus(event: PipelineEvent): void {
  const update = healthFromEvent(event);
  if (!update) return;
  tail = tail
    .then(async () => {
      const map = await loadSourceStatus();
      map[update.source] = update.health;
      await browser.storage.local.set({ [KEY]: map });
    })
    .catch(() => {});
}

/** Calls `onChange` whenever a search records something; returns the unsubscribe. */
export function watchSourceStatus(onChange: (map: SourceHealthMap) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && changes[KEY]) onChange((changes[KEY].newValue as SourceHealthMap | undefined) ?? {});
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
