import type { BridgeClient } from '@kiwi-search/protocol';

/**
 * A page restored from the browser's back-forward cache keeps its script state but not necessarily its link to the extension (the extension may have
 * been reloaded meanwhile). One cheap request tells; if it fails, the page loads again, which makes a new link. The search is in the fragment, so it is kept.
 */
export function reloadIfLinkDiedWhileAway(
  win: Pick<Window, 'addEventListener'> & { location: Pick<Location, 'reload'> },
  client: Pick<BridgeClient, 'request'>,
  probeMs = 3000,
): void {
  win.addEventListener('pageshow', (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    client.request('prefs.load', undefined, probeMs).catch(() => win.location.reload());
  });
}
