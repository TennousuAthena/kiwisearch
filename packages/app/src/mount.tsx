import { createRoot, type Root } from 'react-dom/client';
import './lib/base.css';
import './app/style.css';
import App from './app/App';
import type { KiwiHost } from './host';
import { initLocale } from './i18n';
import { KiwiHostProvider } from './lib/hostContext';
import { configureUiPreferences, initializeUiPreferences } from './lib/uiPreferences';

/** Starts the search interface in `container`, talking to the outside only through `host`. */
export function mountSearchApp(container: HTMLElement, host: KiwiHost): Root {
  configureUiPreferences(host.preferences);
  void initializeUiPreferences().catch(() => {});
  document.documentElement.lang = initLocale();
  const root = createRoot(container);
  root.render(<KiwiHostProvider host={host}><App /></KiwiHostProvider>);
  return root;
}
