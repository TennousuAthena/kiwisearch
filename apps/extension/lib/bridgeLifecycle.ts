/**
 * What the content script does as its page goes away and comes back. A page that is only being cached for Back (the browser's back-forward cache,
 * `persisted`) is not gone: it returns with its script state intact, so the link to the extension must survive it. Closing the relay then left the
 * restored page with a dead link, and its next search waited for ever. Only a page that is really going away closes the link.
 */
export function createBridgeLifecycle(controls: {
  /** Closes the relay and the push port. */
  closeAll(): void;
  /** Starts the push port again; a restored page's old one may have been cut while it was cached. */
  restorePush(): void;
}) {
  return {
    pagehide: (persisted: boolean) => { if (!persisted) controls.closeAll(); },
    pageshow: (persisted: boolean) => { if (persisted) controls.restorePush(); },
  };
}
