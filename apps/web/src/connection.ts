import { createBridgeClient, SUPPORTED_PROTOCOLS, type BridgeClient } from '@kiwi-search/protocol';

/** How the page stands with the extension. `ready` has a working link; the others each get a screen of their own. */
export type Connection =
  | { state: 'ready'; client: BridgeClient; ext: string; caps: string[] }
  /** No extension answered: not installed, disabled, or this is a browser without them. */
  | { state: 'missing' }
  /** The extension and this page share no protocol number. `pageIsOld`: the extension is newer than the page; otherwise the extension is the old side. */
  | { state: 'incompatible'; client: BridgeClient; pageIsOld: boolean }
  /** The extension is set to use its own interface and refuses websites. */
  | { state: 'disabled' }
  /** The extension did not answer the handshake (restarting, or updated under this page). */
  | { state: 'unavailable' };

/** What the content script leaves on `<html>` before the page's own scripts run. */
export const readMarker = (doc: Pick<Document, 'documentElement'>): string | null => doc.documentElement.dataset.kiwi ?? null;

/**
 * Whether the extension's content script has marked the page. It runs at `document_start`, so the mark is there when this page's first
 * script runs; the short wait is for a browser that injects late.
 */
export function waitForMarker(doc: Document = document, waitMs = 300): Promise<boolean> {
  if (readMarker(doc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (found: boolean) => { observer.disconnect(); clearTimeout(timer); resolve(found); };
    const observer = new MutationObserver(() => { if (readMarker(doc)) finish(true); });
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-kiwi'] });
    const timer = setTimeout(() => finish(readMarker(doc) !== null), waitMs);
  });
}

export async function establish(win: Window = window, doc: Document = document): Promise<Connection> {
  if (!(await waitForMarker(doc))) return { state: 'missing' };
  const channel = new MessageChannel();
  // The private port goes to the content script with this one message; everything after it is on the port.
  win.postMessage({ kiwi: 'connect' }, win.location.origin, [channel.port2]);
  const client = createBridgeClient(channel.port1);
  const outcome = await client.hello();
  switch (outcome.state) {
    case 'ok': return { state: 'ready', client, ext: outcome.ext, caps: outcome.caps };
    case 'incompatible': return { state: 'incompatible', client, pageIsOld: outcome.protocols.length > 0 && outcome.protocols.every((p) => p > Math.max(...SUPPORTED_PROTOCOLS)) };
    case 'disabled': client.close(); return { state: 'disabled' };
    case 'unavailable': client.close(); return { state: 'unavailable' };
  }
}
