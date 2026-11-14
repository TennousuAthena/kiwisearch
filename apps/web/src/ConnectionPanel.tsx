import { useState } from 'react';
import { KiwiLogo } from '@kiwi-search/app/KiwiLogo';
import { t } from '@kiwi-search/app/i18n';
import { engineUrl, ENGINES, rememberedEngine, rememberEngine, type EngineId } from './fallback';

/** Where the extension is installed from, and how to update it. The page for it is on the main site. */
export const INSTALL_URL = 'https://kiwi.moe/install';

export type PanelState = 'missing' | 'incompatible' | 'stale' | 'disabled' | 'unavailable';

interface Props {
  state: PanelState;
  /** What was in the address when the page opened; the box keeps it. */
  query: string;
  onOpenLocal?: (query: string) => void;
  store?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

const engineName = (id: EngineId) => (id === 'google' ? t('web.engine.google') : id === 'bing' ? t('web.engine.bing') : id === 'duckduckgo' ? t('web.engine.duckduckgo') : t('web.engine.baidu'));
const panelTitle = (state: PanelState) => (state === 'missing' ? t('web.missing.title') : state === 'incompatible' ? t('web.incompatible.title') : state === 'stale' ? t('web.stale.title') : state === 'disabled' ? t('web.disabled.title') : t('web.unavailable.title'));

/**
 * What the page shows when it has no working link to the extension. It never searches itself: the engines are links the user clicks, and
 * only then is anything sent to them. The search box keeps the query so it is not lost on the way to installing.
 */
export function ConnectionPanel({ state, query: initial, onOpenLocal, store = localStorage }: Props) {
  const [query, setQuery] = useState(initial);
  const [remember, setRemember] = useState(false);
  const [remembered, setRemembered] = useState<EngineId | null>(() => rememberedEngine(store));
  // The page being old is fixed by loading it again; offering other engines there would only be in the way.
  const showEngines = state === 'missing' || state === 'unavailable' || state === 'incompatible';

  return (
    <main className="panel">
      <a className="panel-logo" href="/" aria-label="Kiwi Search"><KiwiLogo /></a>
      <form className="panel-search" onSubmit={(event) => { event.preventDefault(); if (remembered && query.trim()) location.assign(engineUrl(remembered, query.trim())); }}>
        <input type="text" inputMode="search" enterKeyHint="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('web.search.label')} autoFocus />
      </form>
      <h1 className="panel-title">{panelTitle(state)}</h1>
      {state === 'missing' && <a className="btn primary" href={INSTALL_URL} target="_blank" rel="noreferrer">{t('web.missing.install')}</a>}
      {state === 'incompatible' && (
        <div className="panel-actions">
          <a className="btn primary" href={INSTALL_URL} target="_blank" rel="noreferrer">{t('web.incompatible.update')}</a>
          {onOpenLocal && <button type="button" className="btn" onClick={() => onOpenLocal(query)}>{t('web.incompatible.local')}</button>}
        </div>
      )}
      {state === 'stale' && <button type="button" className="btn primary" onClick={() => location.reload()}>{t('web.stale.reload')}</button>}
      {state === 'unavailable' && <button type="button" className="btn primary" onClick={() => location.reload()}>{t('web.unavailable.reload')}</button>}
      {state === 'disabled' && <p className="panel-hint">{t('web.disabled.hint')}</p>}
      {showEngines && (
        <section className="panel-engines" aria-label={t('web.engines.label')}>
          <p>{t('web.engines.label')}</p>
          <ul>
            {ENGINES.map((engine) => (
              <li key={engine.id}>
                <a href={engineUrl(engine.id, query.trim())} rel="noreferrer" onClick={() => { if (remember) { rememberEngine(store, engine.id); setRemembered(engine.id); } }}>{engineName(engine.id)}</a>
              </li>
            ))}
          </ul>
          <label className="panel-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />{t('web.engines.remember')}</label>
          {remembered && <p className="panel-hint">{t('web.engines.remembered', { engine: engineName(remembered) })} <button type="button" className="link" onClick={() => { rememberEngine(store, null); setRemembered(null); }}>{t('web.engines.forget')}</button></p>}
        </section>
      )}
    </main>
  );
}
