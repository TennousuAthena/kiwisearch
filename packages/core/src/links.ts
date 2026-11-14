import { isGoogleGotoUrl } from './engines/google';
import type { FusedResult } from './types';

/**
 * A Google result link (`/goto?url=<encrypted token>`) that nothing turned into the page's address: `google.resolve` could not (Google
 * sometimes answers the request with a page instead of a redirect) and no other engine returned the same page, so the fusion could not
 * merge it either. It still opens (Google redirects when it is clicked), but it cannot be merged with other engines' results, its page
 * cannot be fetched for the overview and a client that is not a browser cannot follow it.
 */
export const isUnresolvedLink = (result: Pick<FusedResult, 'url'>): boolean => isGoogleGotoUrl(result.url);

/**
 * Puts the links `isUnresolvedLink` names into the hidden results, unless fewer than `minVisible` other results would stay on the page:
 * then they stay where they were, so a search whose only source is Google does not come back empty in a moment when Google will not
 * say where its links lead. Anything already hidden keeps the reason it has. Visible results come first, as `arrange` in judge.ts leaves them.
 */
export function hideUnresolvedLinks(results: FusedResult[], minVisible: number): FusedResult[] {
  if (!results.some((result) => !result.hidden && isUnresolvedLink(result))) return results;
  const others = results.filter((result) => !result.hidden && !isUnresolvedLink(result)).length;
  if (others < minVisible) return results;
  const marked = results.map((result): FusedResult => (!result.hidden && isUnresolvedLink(result) ? { ...result, hidden: { reason: 'unresolved' } } : result));
  return [...marked.filter((result) => !result.hidden), ...marked.filter((result) => result.hidden)];
}
