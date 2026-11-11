import { browser } from 'wxt/browser';
import { fetchSiteIcon, fetchableHost, imageDataUrl } from './favicon';

/**
 * Where the new-tab page gets site icons (see `favicon.ts` for why Chrome's own API is not enough on its own).
 * Order: the icon the browser already has, then the site's own icon, then none (the page draws a letter).
 * Answers are cached in `storage.local`, one key per host, so a repeated search asks no site again.
 */

interface Entry {
  src: string | null;
  at: number;
}

const PREFIX = 'favicon:';
const HIT_TTL_MS = 7 * 24 * 3600_000;
/** A miss is kept for a short while only: it may have been a flaky connection. */
const MISS_TTL_MS = 6 * 3600_000;
const MAX_ENTRIES = 500;
const KEEP_ENTRIES = 400;
const MAX_PARALLEL = 4;
const PRUNE_EVERY = 40;

const pending = new Map<string, Promise<string | null>>();
let running = 0;
const waiting: (() => void)[] = [];
let writes = 0;

/** At most `MAX_PARALLEL` site requests at once: a results page can ask for twenty hosts in the same moment. */
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  else running++;
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

function faviconApi(pageUrl: string): string {
  // `getURL` only accepts the extension's own pages as typed paths; `_favicon` is a built-in endpoint on the same origin.
  const url = new URL(browser.runtime.getURL('/newtab.html'));
  url.pathname = '/_favicon/';
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', '64');
  return url.href;
}

async function apiBytes(pageUrl: string): Promise<Uint8Array | null> {
  const response = await fetch(faviconApi(pageUrl));
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
}

/** What the API answers for a page the browser has never seen: the same placeholder for every such page. */
let placeholder: Promise<Uint8Array | null> | undefined;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** The icon the browser itself holds for this site (visited or bookmarked), if any. Free, and sends nothing anywhere. */
async function browserIcon(host: string): Promise<string | null> {
  try {
    placeholder ??= apiBytes('https://kiwi-placeholder.invalid/').catch(() => null);
    const [icon, none] = await Promise.all([apiBytes(`https://${host}/`), placeholder]);
    if (!icon?.length || (none && sameBytes(icon, none))) return null;
    return imageDataUrl(icon);
  } catch {
    return null;
  }
}

async function remember(key: string, entry: Entry): Promise<void> {
  await browser.storage.local.set({ [key]: entry });
  if (++writes % PRUNE_EVERY !== 0) return;
  const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
  const keys = Object.keys(all).filter((name) => name.startsWith(PREFIX));
  if (keys.length <= MAX_ENTRIES) return;
  keys.sort((a, b) => ((all[a] as Entry).at ?? 0) - ((all[b] as Entry).at ?? 0));
  await browser.storage.local.remove(keys.slice(0, keys.length - KEEP_ENTRIES));
}

async function resolveHost(host: string): Promise<string | null> {
  const key = PREFIX + host;
  const saved = ((await browser.storage.local.get(key)) as Record<string, Entry | undefined>)[key];
  if (saved && Date.now() - saved.at < (saved.src ? HIT_TTL_MS : MISS_TTL_MS)) return saved.src;
  const src = (await browserIcon(host)) ?? (await limited(() => fetchSiteIcon(host)));
  await remember(key, { src, at: Date.now() }).catch(() => {});
  return src;
}

export function faviconFor(rawHost: string): Promise<string | null> {
  const host = rawHost.trim().toLowerCase();
  if (!fetchableHost(host)) return Promise.resolve(null);
  let request = pending.get(host);
  if (!request) {
    request = resolveHost(host).finally(() => pending.delete(host));
    pending.set(host, request);
  }
  return request;
}

export async function handleFaviconMessage(message: unknown): Promise<{ src: string | null }> {
  const host = (message as { host?: unknown }).host;
  return { src: typeof host === 'string' ? await faviconFor(host) : null };
}
