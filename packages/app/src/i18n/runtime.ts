/**
 * The message format and the lookup, with no knowledge of any catalog and no browser or React in it, so the service worker,
 * the pages and the tests all use it.
 *
 * A message is a plain string:
 * - `{name}` is replaced by a value: `"{count} 条结果"`.
 * - `<tag>…</tag>` marks a stretch that the caller renders as an element (a link, a `<code>`): `"见<link>设置</link>"`.
 *   Read it with `rich` (see `rich.tsx`); `t` would leave the tags in.
 * Text that has to keep its braces or angle brackets (a code sample) is read with `raw`, which formats nothing.
 *
 * Plural forms are not supported, because the one language there is has none. Adding a second language that needs them
 * (English: "1 result", "2 results") means extending `formatMessage` here.
 */

export type ParamValue = string | number;

/** The `{name}` placeholders of a message, as a union of names. A brace pair with a space or quote in it is not a placeholder. */
export type Params<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? (P extends `${string}${' ' | '"' | ':' | ','}${string}` ? never : P) | Params<Rest>
  : never;

/** The `<tag>` names of a message (closing tags are not counted). */
export type Tags<S extends string> = S extends `${string}<${infer T}>${infer Rest}` ? (T extends `/${string}` ? never : T) | Tags<Rest> : never;

/** The arguments `t` takes after the key: none for a message without placeholders, otherwise one object with all of them. */
export type ParamArgs<S extends string> = [Params<S>] extends [never] ? [] : [params: Record<Params<S>, ParamValue>];

/** Fills in the `{name}` placeholders. One that has no value is left as written, so a bug shows up on the page instead of crashing it. */
export function formatMessage(template: string, params?: Record<string, ParamValue>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (params && name in params ? String(params[name]) : match));
}

export type RichPart = string | { tag: string; children: RichPart[] };

/** Splits a message at its `<tag>…</tag>` pairs. A closing tag that matches nothing stays in the text. */
export function parseRich(template: string): RichPart[] {
  const root: RichPart[] = [];
  const open: { tag: string; children: RichPart[] }[] = [];
  const into = () => (open.length ? open[open.length - 1].children : root);
  const pattern = /<(\/?)([a-zA-Z][\w-]*)>/g;
  let last = 0;
  for (let match = pattern.exec(template); match; match = pattern.exec(template)) {
    if (match.index > last) into().push(template.slice(last, match.index));
    last = pattern.lastIndex;
    if (!match[1]) {
      const node = { tag: match[2], children: [] as RichPart[] };
      into().push(node);
      open.push(node);
    } else if (open.length && open[open.length - 1].tag === match[2]) {
      open.pop();
    } else {
      into().push(match[0]);
    }
  }
  if (last < template.length) into().push(template.slice(last));
  return root;
}

/** The names a message uses, for checking that a translation keeps the placeholders and tags of the source text. */
export function placeholdersOf(template: string): { params: string[]; tags: string[] } {
  const params = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const tags = [...template.matchAll(/<([a-zA-Z][\w-]*)>/g)].map((m) => m[1]);
  return { params: [...new Set(params)].sort(), tags: [...new Set(tags)].sort() };
}

const norm = (tag: string) => tag.toLowerCase().replace(/_/g, '-');

/**
 * The first of the `requested` languages (a browser's `navigator.languages`) that `available` can serve: an exact match, else
 * one with the same first part (`zh-TW` is served by `zh-CN`, `en-GB` by `en`). `fallback` when nothing fits.
 */
export function resolveLocale(requested: readonly string[], available: readonly string[], fallback: string): string {
  for (const want of requested) {
    const tag = norm(want);
    const exact = available.find((have) => norm(have) === tag);
    if (exact) return exact;
    const same = available.find((have) => norm(have).split('-')[0] === tag.split('-')[0]);
    if (same) return same;
  }
  return fallback;
}

export interface I18n<C extends Record<string, string>> {
  /** The language the messages were written in, and the one that fills any gap in another. */
  readonly sourceLocale: string;
  readonly locales: string[];
  getLocale(): string;
  /** An unknown locale is ignored: the page keeps the language it has. */
  setLocale(locale: string): void;
  /** The message with its `{name}` placeholders filled in. */
  t<K extends keyof C & string>(key: K, ...params: ParamArgs<C[K]>): string;
  /** The message exactly as written: for text that has braces or angle brackets of its own, and for `rich`. */
  raw<K extends keyof C & string>(key: K): string;
}

/**
 * `source` holds every message in `sourceLocale`; `translations` holds other languages, each possibly partial. A message a
 * translation lacks is read from the source, so a language can ship before it is finished.
 */
export function createI18n<C extends Record<string, string>>(
  source: C,
  sourceLocale: string,
  translations: Record<string, Partial<Record<keyof C, string>>> = {},
): I18n<C> {
  const tables: Record<string, Partial<Record<keyof C, string>>> = { [sourceLocale]: source, ...translations };
  let current = sourceLocale;
  const raw = (key: keyof C & string): string => tables[current][key] ?? source[key] ?? key;
  return {
    sourceLocale,
    locales: Object.keys(tables),
    getLocale: () => current,
    setLocale(locale) {
      if (locale in tables) current = locale;
    },
    t: (key, ...params) => formatMessage(raw(key), params[0] as Record<string, ParamValue> | undefined),
    raw,
  };
}
