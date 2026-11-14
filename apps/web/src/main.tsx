import '@kiwi-search/app/base.css';
import { mountSearchApp } from '@kiwi-search/app';
import { initLocale } from '@kiwi-search/app/i18n';
import { createRoot } from 'react-dom/client';
import './web.css';
import { ConnectionPanel, type PanelState } from './ConnectionPanel';
import { establish } from './connection';
import { engineUrl, modeFromLocation, queryFromLocation, rememberedEngine } from './fallback';
import { createWebHost } from './webHost';

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

function showPanel(state: PanelState, onOpenLocal?: (query: string) => void) {
  createRoot(container).render(<ConnectionPanel state={state} query={queryFromLocation(location)} onOpenLocal={onOpenLocal} />);
}

async function start() {
  const connection = await establish();
  if (connection.state === 'ready') {
    try { sessionStorage.removeItem(RELOADED); } catch { /* nothing to clear */ }
    mountSearchApp(container, createWebHost(connection.client));
    return;
  }
  const query = queryFromLocation(location);
  if (connection.state === 'missing' || connection.state === 'unavailable') {
    // The user asked, earlier, to be sent to an engine of their own choice when Kiwi cannot search.
    const remembered = rememberedEngine(localStorage);
    if (remembered && query.trim()) { location.replace(engineUrl(remembered, query.trim())); return; }
    showPanel(connection.state);
    return;
  }
  if (connection.state === 'incompatible') {
    // The extension is newer than this page: load the page again once; if that did not help, say so.
    if (connection.pageIsOld) { if (!reloadOnce()) showPanel('stale'); return; }
    const mode = modeFromLocation(location);
    showPanel('incompatible', (typed) => { void connection.client.request('openLocal', { query: typed.trim(), mode }).catch(() => {}); });
    return;
  }
  showPanel(connection.state);
}

void start();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // Keeps the page's own files, so a repeat visit does not need the network and the page opens when the site is down.
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
}
