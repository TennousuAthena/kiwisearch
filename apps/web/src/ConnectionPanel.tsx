import { useEffect, useRef, useState } from 'react';
import { KiwiLogo } from '@kiwi-search/app/KiwiLogo';
import { ArrowRightIcon, SearchIcon } from '@kiwi-search/app/icons';
import { t } from '@kiwi-search/app/i18n';
import googleIcon from '../../../packages/app/assets/engine-logos/google.svg';
import bingIcon from '../../../packages/app/assets/engine-logos/bing.svg';
import duckduckgoIcon from '../../../packages/app/assets/engine-logos/duckduckgo.svg';
import baiduIcon from '../../../packages/app/assets/engine-logos/baidu.svg';
import baiduDarkIcon from '../../../packages/app/assets/engine-logos/baidu.dark.svg';
import { engineUrl, ENGINES, rememberedEngine, rememberEngine, safeStorage, type EngineId } from './fallback';
import { InstallOptions } from './InstallOptions';

/** Where the extension is installed from, and how to update it: a page of this site. */
export const INSTALL_URL = '/install';

export type PanelState = 'missing' | 'incompatible' | 'stale' | 'disabled' | 'unavailable';

interface Props {
  state: PanelState;
  /** What is in the address; the box starts from it. A new address needs a new panel (give it `key={query}`). */
  query: string;
  onOpenLocal?: (query: string) => void;
  store?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

const engineIcons = { google: googleIcon, bing: bingIcon, duckduckgo: duckduckgoIcon, baidu: baiduIcon };
const engineName = (id: EngineId) => (id === 'google' ? t('web.engine.google') : id === 'bing' ? t('web.engine.bing') : id === 'duckduckgo' ? t('web.engine.duckduckgo') : t('web.engine.baidu'));
const panelTitle = (state: PanelState) => (state === 'missing' ? t('web.missing.title') : state === 'incompatible' ? t('web.incompatible.title') : state === 'stale' ? t('web.stale.title') : state === 'disabled' ? t('web.disabled.title') : t('web.unavailable.title'));

/** A disconnected page keeps its query, and sends it to another engine only after the user chooses one. */
export function ConnectionPanel({ state, query: initial, onOpenLocal, store = safeStorage() }: Props) {
  const [query, setQuery] = useState(initial);
  const [remember, setRemember] = useState(false);
  const [remembered, setRemembered] = useState<EngineId | null>(() => rememberedEngine(store));
  const firstEngine = useRef<HTMLAnchorElement>(null);
  // The connected app gets its theme from extension preferences. These screens follow the OS without reading extension data.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'; };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
  const showEngines = state === 'missing' || state === 'unavailable' || state === 'incompatible';

  return (
    <div className={`panel${state === 'missing' ? ' panel-missing' : ''}`}>
      {state === 'missing' && <header className="panel-topbar">
        <a className="panel-name" href="/">{t('brand.name')}</a>
        <nav aria-label={t('web.footer.navigation')}><a href="/about">{t('web.footer.about')}</a><a href="/privacy">{t('web.footer.privacy')}</a></nav>
      </header>}
      <main className="panel-layout">
        <section className="panel-search-stage" aria-label={t('web.search.label')}>
          <a className="panel-logo" href="/" aria-label={t('brand.home')}><KiwiLogo /></a>
          {showEngines && <>
            <form className="panel-search" role="search" onSubmit={(event) => {
              event.preventDefault();
              if (remembered && query.trim()) location.assign(engineUrl(remembered, query.trim()));
              else firstEngine.current?.focus();
            }}>
              <SearchIcon />
              <input type="text" inputMode="search" enterKeyHint="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('web.search.label')} placeholder={t('web.search.placeholder')} />
              <button type="submit" aria-label={t('web.search.submit')}><ArrowRightIcon /></button>
            </form>
            <section className="panel-engines" aria-label={t('web.engines.label')}>
              <h2>{t('web.engines.tryFirst')}</h2>
              <ul>
                {ENGINES.map((engine) => (
                  <li key={engine.id}>
                    <a ref={engine.id === ENGINES[0].id ? firstEngine : undefined} href={engineUrl(engine.id, query.trim())} rel="noreferrer" onClick={() => { if (remember) { rememberEngine(store, engine.id); setRemembered(engine.id); } }}>
                      <img className={engine.id === 'baidu' ? 'engine-art engine-art-light' : 'engine-art'} src={engineIcons[engine.id]} alt="" aria-hidden="true" />
                      {engine.id === 'baidu' && <img className="engine-art engine-art-dark" src={baiduDarkIcon} alt="" aria-hidden="true" />}
                      {engineName(engine.id)}
                    </a>
                  </li>
                ))}
              </ul>
              <label className="panel-remember"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />{t('web.engines.remember')}</label>
              {remembered && <p className="panel-hint">{t('web.engines.remembered', { engine: engineName(remembered) })} <button type="button" className="link" onClick={() => { rememberEngine(store, null); setRemembered(null); }}>{t('web.engines.forget')}</button></p>}
            </section>
          </>}
        </section>
        <section className="panel-connection" aria-labelledby="connection-title">
          {state === 'missing' && <p className="panel-eyebrow">{t('web.install.eyebrow')}</p>}
          <h1 className="panel-title" id="connection-title">{panelTitle(state)}</h1>
          {state === 'missing' && <>
            <p className="panel-hint">{t('web.missing.hint')}</p>
            <InstallOptions />
            <div className="panel-install-help">
              <a href={INSTALL_URL} target="_blank" rel="noreferrer">{t('web.install.guide')}<ArrowRightIcon /></a>
              <button type="button" className="link" onClick={() => location.reload()}>{t('web.install.refresh')}</button>
            </div>
          </>}
          {state === 'incompatible' && (
            <div className="panel-actions">
              <a className="btn primary" href={INSTALL_URL} target="_blank" rel="noreferrer">{t('web.incompatible.update')}</a>
              {onOpenLocal && <button type="button" className="btn" onClick={() => onOpenLocal(query)}>{t('web.incompatible.local')}</button>}
            </div>
          )}
          {state === 'stale' && <button type="button" className="btn primary" onClick={() => location.reload()}>{t('web.stale.reload')}</button>}
          {state === 'unavailable' && <button type="button" className="btn primary" onClick={() => location.reload()}>{t('web.unavailable.reload')}</button>}
          {state === 'disabled' && <p className="panel-hint">{t('web.disabled.hint')}</p>}
        </section>
      </main>
      {state === 'missing' && <footer className="panel-footer"><span>{t('brand.name')}</span><a href={INSTALL_URL}>{t('web.install.guide')}</a></footer>}
    </div>
  );
}
