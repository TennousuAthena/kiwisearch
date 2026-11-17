import { useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '@kiwi-search/app/i18n';
import { tr } from '@kiwi-search/app/i18n/rich';
import { CheckIcon, CopyIcon } from '@kiwi-search/app/icons';

const DEFAULT_SEARCH_FIELDS = [
  { id: 'name', labelKey: 'options.start.fieldName', value: 'Kiwi Search' },
  { id: 'keyword', labelKey: 'options.start.fieldKeyword', value: 'kiwi' },
  { id: 'url', labelKey: 'options.start.fieldUrl', value: 'https://kiwi.moe/#q=%s' },
] as const;

// Firefox refuses to open its own settings pages from an extension, so there the address is shown to copy instead.
const FIREFOX = import.meta.env.FIREFOX;
const SEARCH_ENGINES_URL = FIREFOX ? 'about:preferences#search' : 'chrome://settings/searchEngines';

/** How to add Kiwi as the browser's search by hand: Chrome and Firefox do not let an extension do it. Used by the settings page and the onboarding page. */
export function DefaultSearchSteps() {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [settingsFallback, setSettingsFallback] = useState(false);

  async function copy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setCopyError(false);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopyError(true);
    }
  }

  async function openSearchEngineSettings() {
    setSettingsFallback(false);
    try {
      await browser.tabs.create({ url: SEARCH_ENGINES_URL });
    } catch {
      setSettingsFallback(true);
    }
  }

  return (
    <div className="default-search">
      <p className="note">{tr('options.start.defaultNote', { tags: { code: (text) => <code>{text}</code> } })}</p>
      <div className="copy-grid">
        {DEFAULT_SEARCH_FIELDS.map(({ id, labelKey, value }) => (
          <div className="copy-item" key={id}>
            <span>{t(labelKey)}</span>
            <code>{value}</code>
            <button type="button" className="btn small" aria-label={t('options.start.copyField', { field: t(labelKey) })} onClick={() => void copy(id, value)}>
              {copied === id ? (
                <>
                  <CheckIcon />
                  {t('options.start.copyDone')}
                </>
              ) : (
                <>
                  <CopyIcon />
                  {t('options.start.copy')}
                </>
              )}
            </button>
          </div>
        ))}
      </div>
      {copyError && (
        <p className="note" role="alert">
          {t('options.start.copyFailed')}
        </p>
      )}
      <p className="note">
        {t(FIREFOX ? 'options.start.addStepsFirefox' : 'options.start.addSteps')}
      </p>
      {FIREFOX ? (
        <div className="copy-grid">
          <div className="copy-item">
            <span>{t('options.start.fieldSettings')}</span>
            <code>{SEARCH_ENGINES_URL}</code>
            <button type="button" className="btn small" aria-label={t('options.start.copyField', { field: t('options.start.fieldSettings') })} onClick={() => void copy('settings', SEARCH_ENGINES_URL)}>
              {copied === 'settings' ? (
                <>
                  <CheckIcon />
                  {t('options.start.copyDone')}
                </>
              ) : (
                <>
                  <CopyIcon />
                  {t('options.start.copy')}
                </>
              )}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => void openSearchEngineSettings()}>
          {t('options.start.openSettings')}
        </button>
      )}
      {settingsFallback && (
        <p className="note">
          {tr('options.start.openFailed', { tags: { code: (text) => <code>{text}</code> }, params: { url: SEARCH_ENGINES_URL } })}
        </p>
      )}
    </div>
  );
}
