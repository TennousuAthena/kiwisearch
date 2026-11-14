import type { FusionConfig, SourceId } from '@kiwi-search/core';
import { useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '@kiwi-search/app/i18n';
import { tr } from '@kiwi-search/app/i18n/rich';
import { CheckIcon, CopyIcon } from '@kiwi-search/app/icons';
import { SOURCE_INFO } from '@/lib/sourceCatalog';
import type { SourceHealthMap } from '@/lib/sourceHealth';
import { sourceLabel } from '@/lib/sourceMeta';
import { describeSource } from '@/lib/sourceView';

const DEFAULT_SEARCH_FIELDS = [
  { id: 'name', labelKey: 'options.start.fieldName', value: 'Kiwi Search' },
  { id: 'keyword', labelKey: 'options.start.fieldKeyword', value: 'kiwi' },
  { id: 'url', labelKey: 'options.start.fieldUrl', value: 'https://s.kiwi.moe/s?q=%s' },
] as const;

// Firefox refuses to open its own settings pages from an extension, so there the address is shown to copy instead.
const FIREFOX = import.meta.env.FIREFOX;
const SEARCH_ENGINES_URL = FIREFOX ? 'about:preferences#search' : 'chrome://settings/searchEngines';

interface Props {
  config: FusionConfig;
  health: SourceHealthMap;
  /** Set when shown as the first-run guide; absent when it is the copy kept under "高级". */
  onDone?: () => void;
}

/**
 * Three things worth doing once: make Kiwi the browser's search, sign in to the platforms you want searched, and
 * (optionally) add keys. Nothing here is required: the search works without any of it.
 */
export function StartSection({ config, health, onDone }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [settingsFallback, setSettingsFallback] = useState(false);
  const platforms = (Object.keys(SOURCE_INFO) as SourceId[]).filter((id) => SOURCE_INFO[id].login && config.sources[id]?.enabled);

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
    <div className="start">
      <ol className="start-steps">
        <li>
          <h3>{t('options.start.defaultTitle')}</h3>
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
        </li>
        <li>
          <h3>{t('options.start.loginTitle')}</h3>
          <p className="note">{t('options.start.loginNote')}</p>
          {platforms.length ? (
            <ul className="start-platforms">
              {platforms.map((id) => {
                const badge = describeSource(id, config, health[id]);
                return (
                  <li key={id}>
                    <span>{sourceLabel(id)}</span>
                    {badge && <span className={`state state-${badge.tone}`}>{badge.label}</span>}
                    <a className="btn small" href={SOURCE_INFO[id].loginUrl} target="_blank" rel="noreferrer">
                      {t('options.start.loginAction')}
                    </a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="note">{t('options.start.noPlatforms')}</p>
          )}
        </li>
        <li>
          <h3>{t('options.start.keysTitle')}</h3>
          <p className="note">
            {tr('options.start.keys', { tags: { aiLink: (text) => <a href="#ai">{text}</a>, sourcesLink: (text) => <a href="#sources">{text}</a> } })}
          </p>
        </li>
      </ol>
      {onDone && (
        <div className="start-done">
          <button type="button" className="btn btn-primary" onClick={onDone}>
            {t('options.start.done')}
          </button>
          <span className="note">{t('options.start.doneNote')}</span>
        </div>
      )}
    </div>
  );
}
