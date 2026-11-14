/**
 * The pages that may talk to the extension: the search page of the Kiwi website, `https://kiwi.moe/` and nothing else on that host (the
 * introduction, install and privacy pages have no use for it). Fixed when the extension is built: nothing the user or a page sends can add to it.
 * A build can add one development origin (`WXT_KIWI_WEB_DEV_ORIGIN=http://localhost:5173 pnpm build`) for working on the website, with every
 * path of it allowed; the store builds are made without it.
 */
const DEV_ORIGIN: string | undefined = import.meta.env.WXT_KIWI_WEB_DEV_ORIGIN || undefined;

export interface WebSite {
  origin: string;
  /** The paths of the origin that may use the bridge; `null` is every path. */
  paths: readonly string[] | null;
}

export const SITE_ORIGIN = 'https://kiwi.moe';

export const WEB_SITES: readonly WebSite[] = [
  { origin: SITE_ORIGIN, paths: ['/'] },
  ...(DEV_ORIGIN ? [{ origin: new URL(DEV_ORIGIN).origin, paths: null }] : []),
];

/** Match patterns for the content script. A pattern has no port, so a development origin matches on its host. */
export const WEB_MATCHES: string[] = [...new Set(WEB_SITES.map(({ origin, paths }) => {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}${paths ? paths[0] : '/*'}`;
}))];

/** Whether an address is a page that may use the bridge. */
export function isWebSitePage(url: URL, sites: readonly WebSite[] = WEB_SITES): boolean {
  return sites.some((site) => site.origin === url.origin && (site.paths === null || site.paths.includes(url.pathname)));
}
