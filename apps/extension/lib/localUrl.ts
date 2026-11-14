import { writePageLocation } from '@kiwi-search/app/pageLocation';

/** The origin of the website. The extension only ever opens or rewrites to this one. */
export const SITE_ORIGIN = 'https://s.kiwi.moe';

/** A search in the extension's own interface, in the same address form the website uses (`#m=news&q=…`). */
export function localSearchUrl(appUrl: string, query: string, mode: string): string {
  return writePageLocation(appUrl, 'hash', { query, mode });
}

/** A search on the website; the query is in the fragment, so it is not sent to the server. */
export function siteSearchUrl(query: string, mode: string): string {
  return writePageLocation(`${SITE_ORIGIN}/`, 'hash', { query, mode });
}
