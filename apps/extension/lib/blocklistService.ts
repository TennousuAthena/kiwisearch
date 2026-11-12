import {
  activeSubscriptions,
  parseBlocklist,
  type BlockRules,
  type BlocklistSettings,
  type BlocklistSource,
  type NamedBlockRules,
} from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { downloadList, isDue, metaAfterDownload, type BlocklistMeta, type BlocklistMetaMap } from './blocklistState';
import { loadConfig } from './settings';

/**
 * Subscribed block lists, kept in `storage.local`: what was learned about each under `blocklistMeta` (small, read by the settings page),
 * and each list's parsed rules under `blocklist:<id>` (large, read only by a search). The background refreshes them: when one is
 * switched on, once a day, and on demand from the settings page. A failed refresh leaves the rules kept before in use.
 */

const META_KEY = 'blocklistMeta';
const DATA_PREFIX = 'blocklist:';

export async function loadBlocklistMeta(): Promise<BlocklistMetaMap> {
  const stored = (await browser.storage.local.get(META_KEY))[META_KEY];
  return stored && typeof stored === 'object' ? (stored as BlocklistMetaMap) : {};
}

/** Calls `onChange` whenever a refresh records something; returns the unsubscribe. */
export function watchBlocklistMeta(onChange: (map: BlocklistMetaMap) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && changes[META_KEY]) onChange((changes[META_KEY].newValue as BlocklistMetaMap | undefined) ?? {});
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Read-modify-write through one chain, so lists refreshing one after another can't overwrite each other's entry. */
let metaTail: Promise<void> = Promise.resolve();

function updateMeta(id: string, change: (current: BlocklistMeta | undefined) => BlocklistMeta | undefined): Promise<void> {
  metaTail = metaTail
    .then(async () => {
      const map = await loadBlocklistMeta();
      const next = change(map[id]);
      if (next) map[id] = next;
      else delete map[id];
      await browser.storage.local.set({ [META_KEY]: map });
    })
    .catch(() => {});
  return metaTail;
}

/** Parsed rules already read from storage, by list id: a search must not parse a megabyte of JSON each time. */
const memory = new Map<string, { fetchedAt: number; url: string; rules: BlockRules }>();

/** The rules of the subscribed lists that are switched on and have been downloaded. This is what a search asks for (`Env.loadBlocklists`). */
export async function loadBlocklistRules(settings: BlocklistSettings): Promise<NamedBlockRules[]> {
  const sources = activeSubscriptions(settings);
  if (!sources.length) return [];
  const metas = await loadBlocklistMeta();
  const out: NamedBlockRules[] = [];
  for (const source of sources) {
    const meta = metas[source.id];
    if (!meta?.fetchedAt || meta.url !== source.url) continue;
    let held = memory.get(source.id);
    if (held?.fetchedAt !== meta.fetchedAt || held.url !== meta.url) {
      const stored = (await browser.storage.local.get(DATA_PREFIX + source.id))[DATA_PREFIX + source.id] as { rules?: BlockRules } | undefined;
      if (!stored?.rules) continue;
      held = { fetchedAt: meta.fetchedAt, url: meta.url, rules: stored.rules };
      memory.set(source.id, held);
    }
    out.push({ id: source.id, name: source.name, rules: held.rules });
  }
  return out;
}

async function refreshOne(source: BlocklistSource): Promise<void> {
  const before = (await loadBlocklistMeta())[source.id];
  const kept = before?.url === source.url ? before : undefined;
  await updateMeta(source.id, () => ({ ...(kept ?? { url: source.url }), updatingSince: Date.now() }));
  const attemptedAt = Date.now();
  try {
    const got = await downloadList((input, init) => fetch(input, init), source.url, kept?.fetchedAt ? kept.etag : undefined);
    if (got.kind === 'not-modified') {
      await updateMeta(source.id, (current) => ({ ...(current ?? { url: source.url }), attemptedAt, error: undefined, updatingSince: undefined }));
      return;
    }
    const parsed = parseBlocklist(got.text);
    if (!parsed.stats.rules) throw new Error('没有读到可用的规则，这个地址返回的可能不是屏蔽列表');
    try {
      await browser.storage.local.set({ [DATA_PREFIX + source.id]: { rules: parsed.rules } });
    } catch {
      throw new Error('浏览器的存储空间不够，存不下这个列表');
    }
    memory.delete(source.id);
    await updateMeta(source.id, () => metaAfterDownload(source.url, parsed, got.etag, Date.now()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateMeta(source.id, (current) => ({ ...(current ?? { url: source.url }), attemptedAt, error: message, updatingSince: undefined }));
  }
}

/** Forget lists that are no longer part of the settings (removed, or a recommended one switched off). */
async function prune(settings: BlocklistSettings): Promise<void> {
  const keep = new Set([...settings.recommended, ...settings.subscriptions.map((sub) => sub.id)]);
  const stale = Object.keys(await loadBlocklistMeta()).filter((id) => !keep.has(id));
  if (!stale.length) return;
  for (const id of stale) memory.delete(id);
  await browser.storage.local.remove(stale.map((id) => DATA_PREFIX + id));
  for (const id of stale) await updateMeta(id, () => undefined);
}

interface RefreshOptions {
  /** Fetch even when the kept copy is recent. */
  force?: boolean;
  /** Only these lists. */
  ids?: string[];
}

/** One pass at a time: a request that arrives during a pass runs after it, so a switch turned on meanwhile is not missed. */
let passes: Promise<void> = Promise.resolve();

export function refreshBlocklists(settings: BlocklistSettings, options: RefreshOptions = {}): Promise<void> {
  passes = passes
    .then(async () => {
      const sources = activeSubscriptions(settings).filter((source) => !options.ids || options.ids.includes(source.id));
      const metas = await loadBlocklistMeta();
      const now = Date.now();
      for (const source of sources) if (options.force || isDue(metas[source.id], source, now)) await refreshOne(source);
      await prune(settings);
    })
    .catch(() => {});
  return passes;
}

/** Brings the lists that are due up to date, with the settings as they are now. */
export async function refreshDueBlocklists(): Promise<void> {
  await refreshBlocklists((await loadConfig()).judge.blocklists);
}

/** `kiwi:blocklist-refresh`: the settings page's "立即更新". Answers when the lists have been tried. */
export async function handleBlocklistMessage(message: unknown): Promise<{ ok: true }> {
  const ids = (message as { ids?: unknown }).ids;
  await refreshBlocklists((await loadConfig()).judge.blocklists, { force: true, ids: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : undefined });
  return { ok: true };
}
