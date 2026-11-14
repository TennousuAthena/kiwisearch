import '@kiwi-search/app/base.css';
import { mountSearchApp } from '@kiwi-search/app';
import { initLocale } from '@kiwi-search/app/i18n';
import { createRoot, type Root } from 'react-dom/client';
import './web.css';
import { dropQueryString, watchAddress } from './address';
import { ConnectionPanel, type PanelState } from './ConnectionPanel';
import { establish } from './connection';
import { modeFromLocation, queryFromLocation, redirectToRememberedEngine, safeStorage } from './fallback';
import { reloadIfLinkDiedWhileAway } from './restore';
import { createWebHost } from './webHost';

// Before anything reads the address: a search on this site is only ever the part after the `#`.
dropQueryString(window);
const container = document.getElementById('root')!;
document.documentElement.lang = initLocale();

/** A page that finds the extension newer than itself loads once more, which brings the current release (and its service worker); never twice in a row. */
const RELOADED = 'kiwi:reloaded';
function reloadOnce(): boolean {
  try {
    if (sessionStorage.getItem(RELOADED)) return false;
    sessionStorage.setItem(RELOADED, '1');
  } catch { return false; }
  void (async () => {
    try { await (await navigator.serviceWorker?.getRegistration())?.update(); } catch { /* no service worker yet */ }
    location.reload();
  })();
  return true;
}

let panelRoot: Root | undefined;
let panel: { state: PanelState; onOpenLocal?: (query: string, mode: string) => void } | undefined;

function renderPanel() {
  if (!panel) return;
  const query = queryFromLocation(location);
  panelRoot ??= createRoot(container);
  // A new address (a new search typed into this tab) is a new panel, so the box and the links follow it.
  panelRoot.render(<ConnectionPanel key={query} state={panel.state} query={query} onOpenLocal={panel.onOpenLocal && ((typed) => panel?.onOpenLocal?.(typed, modeFromLocation(location)))} />);
}

/** Shows the screen for a state without a working link, and keeps it in step with the address. */
function showPanel(state: PanelState, onOpenLocal?: (query: string, mode: string) => void) {
  const first = !panel;
  panel = { state, onOpenLocal };
  renderPanel();
  if (!first) return;
  watchAddress(window, () => {
    if (!panel || redirectToRememberedEngine(panel.state, queryFromLocation(location), safeStorage(), (url) => location.replace(url))) return;
    renderPanel();
  });
}

async function start() {
  const connection = await establish();
  if (connection.state === 'ready') {
    try { sessionStorage.removeItem(RELOADED); } catch { /* nothing to clear */ }
    mountSearchApp(container, createWebHost(connection.client));
    reloadIfLinkDiedWhileAway(window, connection.client);
    return;
  }
  // The user asked, earlier, to be sent to an engine of their own choice when Kiwi cannot search.
  if (redirectToRememberedEngine(connection.state, queryFromLocation(location), safeStorage(), (url) => location.replace(url))) return;
  if (connection.state === 'incompatible') {
    // The extension is newer than this page: load the page again once; if that did not help, say so.
    if (connection.pageIsOld) { if (!reloadOnce()) showPanel('stale'); return; }
    showPanel('incompatible', (typed, mode) => { void connection.client.request('openLocal', { query: typed.trim(), mode }).catch(() => {}); });
    return;
  }
  showPanel(connection.state);
}

void start();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // Keeps the page's own files, so a repeat visit does not need the network and the page opens when the site is down.
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
}
