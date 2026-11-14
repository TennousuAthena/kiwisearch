/**
 * The website takes a search only from the part of the address after `#`, which the browser never sends. A `?…` on the search page is dropped
 * before anything reads it, so a search is never started from, and never kept in, a query string. (The request that carried it has been sent; this
 * only makes sure the page does not act on it.)
 */
export function dropQueryString(win: { location: Pick<Location, 'search' | 'pathname' | 'hash'>; history: Pick<History, 'replaceState'> }): boolean {
  if (!win.location.search) return false;
  win.history.replaceState(null, '', win.location.pathname + win.location.hash);
  return true;
}

/** Calls `listener` whenever the address changes without a new page (a new search typed into the tab, Back or Forward). Returns the way to stop. */
export function watchAddress(win: Pick<Window, 'addEventListener' | 'removeEventListener'>, listener: () => void): () => void {
  win.addEventListener('hashchange', listener);
  win.addEventListener('popstate', listener);
  return () => { win.removeEventListener('hashchange', listener); win.removeEventListener('popstate', listener); };
}
