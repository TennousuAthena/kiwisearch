import { useId, useState } from 'react';
import { ArrowRightIcon, ChevronDownIcon, ExternalLinkIcon, GlobeIcon } from '@kiwi-search/app/icons';
import { t } from '@kiwi-search/app/i18n';
import { BROWSERS, detectBrowser, RELEASES_URL, STORE_URLS, storeForBrowser, type BrowserId } from './installation';

/** Both distribution channels stay visible before launch; only actual destinations become links. */
export function InstallOptions() {
  const [browser, setBrowser] = useState<BrowserId | null>(() => detectBrowser());
  const id = useId();
  const store = browser ? storeForBrowser(browser) : null;
  const url = store ? STORE_URLS[store] : null;
  const storeContent = <>
    <GlobeIcon className="install-route-icon" />
    <span className="install-route-copy">
      <span className="install-route-title">{browser ? t('web.install.add', { browser: t(`web.browser.${browser}`) }) : t('web.install.chooseBrowser')}</span>
      <span className="install-description" id={`${id}-availability`}>
        {store ? t(url ? 'web.install.storeReady' : 'web.install.storePending', { store: t(`web.store.${store}`) }) : t('web.install.desktop')}
      </span>
    </span>
    <ArrowRightIcon className="install-route-arrow" />
  </>;

  return (
    <div className="install-options">
      <label className="install-browser">
        <span>{t('web.install.browser')}</span>
        <span className="install-select">
          <select value={browser ?? ''} onChange={(event) => setBrowser(event.target.value as BrowserId)}>
            <option value="" disabled>{t('web.install.chooseBrowser')}</option>
            {BROWSERS.map((value) => <option key={value} value={value}>{t(`web.browser.${value}`)}</option>)}
          </select>
          <ChevronDownIcon />
        </span>
      </label>
      <section className="install-store" aria-label={t('web.install.store')} aria-live="polite">
        {url ? (
          <a className="install-route" href={url} target="_blank" rel="noreferrer">{storeContent}</a>
        ) : (
          <button type="button" className="install-route" disabled aria-describedby={`${id}-availability`}>{storeContent}</button>
        )}
      </section>
      <a className="install-route install-release" href={RELEASES_URL} target="_blank" rel="noreferrer">
        <ExternalLinkIcon className="install-route-icon" />
        <span className="install-route-copy">
          <span className="install-route-title">{t('web.install.release')}</span>
          <span className="install-description">{t('web.install.releasePending')}</span>
        </span>
        <ArrowRightIcon className="install-route-arrow" />
      </a>
    </div>
  );
}
