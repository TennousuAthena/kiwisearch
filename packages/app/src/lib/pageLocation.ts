/**
 * The address of a search, in the two forms the interface reads and one of which it writes.
 *
 * - `search` style, the extension's own page: `newtab.html?q=…&m=news&range=7d`.
 * - `hash` style, the website: `https://kiwi.moe/#m=news&range=7d&q=…`. The query is in the fragment so it never reaches the server.
 *
 * In the fragment form `q` is the last parameter and its value is the whole rest of the fragment. A browser's search box that
 * fills `%s` into `#q=%s` escapes spaces and `#`, but leaves `&` (checked in Chromium 156), so `#q=a&b=c` is a search for `a&b=c`,
 * not a search for `a` with a parameter `b`. Addresses written here put every other parameter before `q` and escape the query fully.
 * A `+` in the fragment is a plus, not a space. Both forms are always read, whichever one the page writes.
 */
export type LocationStyle = 'search' | 'hash';

/** The parts of `window.location` that are read. */
export interface LocationParts { search: string; hash: string }

/** Decodes percent escapes, and keeps the text as it is when it is not valid escaping (a stray `%` typed into a search box). */
function lenientDecode(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** The parameters of an address as one `URLSearchParams`, from either form; the fragment wins over the query string. */
export function readPageParams(location: LocationParts): URLSearchParams {
  const params = new URLSearchParams(location.search);
  const fragment = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!fragment) return params;
  let before = fragment;
  let rawQuery: string | null = null;
  if (fragment.startsWith('q=')) {
    before = '';
    rawQuery = fragment.slice(2);
  } else {
    const at = fragment.indexOf('&q=');
    if (at >= 0) { before = fragment.slice(0, at); rawQuery = fragment.slice(at + 3); }
  }
  for (const [key, value] of new URLSearchParams(before)) params.set(key, value);
  if (rawQuery !== null) params.set('q', lenientDecode(rawQuery));
  return params;
}

export interface PageParams {
  query: string;
  mode: string;
  /** Any other parameters, already in their final string form. */
  extra?: Record<string, string>;
}

/** `base` with the address written in `style`: its own query string and fragment are replaced, the rest of it is kept. */
export function writePageLocation(base: string, style: LocationStyle, { query, mode, extra = {} }: PageParams): string {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  const others = new URLSearchParams();
  if (mode !== 'web') others.set('m', mode);
  for (const [key, value] of Object.entries(extra)) others.set(key, value);
  if (style === 'search') {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    for (const [key, value] of others) params.set(key, value);
    url.search = params.toString();
    return url.toString();
  }
  const parts = [others.toString(), query ? `q=${encodeURIComponent(query)}` : ''].filter(Boolean);
  url.hash = parts.join('&');
  return url.toString();
}
