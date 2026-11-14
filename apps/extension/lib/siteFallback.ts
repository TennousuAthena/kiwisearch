import { readPageParams } from '@kiwi-search/app/pageLocation';

/**
 * Errors that mean the website could not be reached: the name does not resolve, the connection is refused, reset or times out, the
 * address is unreachable, or the secure connection fails. Not the user cancelling (`ERR_ABORTED`), not a request that a rule blocked, and not an
 * error page the website sent itself. The first group is Chromium's wording, the second Firefox's (not checked in Firefox).
 */
const UNREACHABLE = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_(?:REFUSED|RESET|CLOSED|TIMED_OUT|FAILED)|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_SSL_PROTOCOL_ERROR|ERR_CERT_|NS_ERROR_UNKNOWN_HOST|NS_ERROR_CONNECTION_REFUSED|NS_ERROR_NET_TIMEOUT|NS_ERROR_NET_RESET|NS_ERROR_NET_ON_TLS_HANDSHAKE_ENDED|SSL_ERROR|MOZILLA_PKIX_ERROR/;

export const isSiteUnreachable = (error: string | undefined): boolean => typeof error === 'string' && UNREACHABLE.test(error) && !/ERR_ABORTED|ERR_BLOCKED/.test(error);

export interface FailedNavigation { url: string; error?: string; frameId: number; tabId: number }

/** The search that was being opened when the website could not be reached, read from the address it failed on (either form), or null if this is not one of ours to handle. */
export function searchFromFailedNavigation(details: FailedNavigation, siteOrigin: string): { query: string; mode: string } | null {
  if (details.frameId !== 0 || details.tabId < 0 || !isSiteUnreachable(details.error)) return null;
  let url: URL;
  try { url = new URL(details.url); } catch { return null; }
  if (url.origin !== siteOrigin) return null;
  const params = readPageParams({ search: url.search, hash: url.hash });
  return { query: params.get('q') ?? '', mode: params.get('m') ?? 'web' };
}
