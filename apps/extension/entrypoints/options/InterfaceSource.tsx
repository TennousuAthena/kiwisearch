import { useId, useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '@kiwi-search/app/i18n';
import { UI_FALLBACK_KEY, UI_SOURCE_KEY, type UiSource } from '@/lib/uiSource';
import { useUiSource } from '@/lib/useUiSource';

/** Where the search interface comes from. The service worker reads the choice and changes its redirects and what it answers the website. */
export function InterfaceSource() {
  const { source, fallback, ready } = useUiSource();
  const [denied, setDenied] = useState(false);
  // The start section can be on the page twice (the first-run guide and the copy under "高级"); each needs its own radio group.
  const group = useId();

  const choose = (next: UiSource) => { void browser.storage.local.set({ [UI_SOURCE_KEY]: next }); };

  const toggleFallback = (on: boolean) => {
    if (!on) {
      setDenied(false);
      void browser.storage.local.set({ [UI_FALLBACK_KEY]: false });
      void browser.permissions.remove({ permissions: ['webNavigation'] }).catch(() => {});
      return;
    }
    // `permissions.request` is the first thing the click does: it needs the click's user activation, which an earlier `await` can use up.
    browser.permissions.request({ permissions: ['webNavigation'] }).then(
      (granted) => { setDenied(!granted); return browser.storage.local.set({ [UI_FALLBACK_KEY]: granted }); },
      () => setDenied(true),
    );
  };

  return (
    <div className="interface-source">
      <p className="note">{t('options.start.uiNote')}</p>
      <fieldset disabled={!ready}>
        <legend className="sr-only">{t('options.start.uiTitle')}</legend>
        <div className="preference-segments two">
          {(['site', 'local'] as const).map((value) => (
            <label key={value}>
              <input type="radio" name={group} checked={source === value} onChange={() => choose(value)} />
              <span>{t(value === 'site' ? 'options.start.uiSite' : 'options.start.uiLocal')}</span>
            </label>
          ))}
        </div>
        <p className="note">{t(source === 'site' ? 'options.start.uiSiteHint' : 'options.start.uiLocalHint')}</p>
      </fieldset>
      {source === 'site' && (
        <>
          <label className="preference-check">
            <input type="checkbox" disabled={!ready} checked={fallback} onChange={(event) => toggleFallback(event.target.checked)} />
            <span>{t('options.start.uiFallback')}</span>
          </label>
          <p className="note">{t('options.start.uiFallbackNote')}</p>
          {denied && <p className="note" role="alert">{t('options.start.uiFallbackDenied')}</p>}
        </>
      )}
      <p className="note">{t('options.start.uiToolbar')}</p>
    </div>
  );
}
