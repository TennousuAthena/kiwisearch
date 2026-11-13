import { t } from './i18n';
import { initializeUiPreferences, useUiPreferences } from './uiPreferences';
import './uiPreferences.css';

export function UiPreferencesPanel() {
  const { preferences, ready, error, update } = useUiPreferences();
  const change = (patch: Parameters<typeof update>[0]) => { void update(patch).catch(() => {}); };
  return <div className="ui-preferences">
    {!ready && <p role="status">{t('ux.preferences.loading')}</p>}
    <fieldset disabled={!ready}>
      <legend>{t('ux.preferences.theme')}</legend>
      <div className="preference-segments">
        {(['system', 'light', 'dark'] as const).map((theme) => <label key={theme}>
          <input type="radio" name="ui-theme" checked={preferences.theme === theme} onChange={() => change({ theme })} />
          <span>{t(`ux.preferences.${theme}`)}</span>
        </label>)}
      </div>
    </fieldset>
    <fieldset disabled={!ready}>
      <legend>{t('ux.preferences.summary')}</legend>
      <div className="preference-segments">
        {(['auto', 'on-demand', 'off'] as const).map((summaryMode) => <label key={summaryMode}>
          <input type="radio" name="ui-summary" checked={preferences.summaryMode === summaryMode} onChange={() => change({ summaryMode })} />
          <span>{t(summaryMode === 'on-demand' ? 'ux.preferences.onDemand' : `ux.preferences.${summaryMode}`)}</span>
        </label>)}
      </div>
      <p>{t('ux.preferences.summaryHint')}</p>
    </fieldset>
    <label className="preference-check"><input type="checkbox" disabled={!ready} checked={preferences.openNewTab} onChange={(e) => change({ openNewTab: e.target.checked })} /><span>{t('ux.preferences.newTab')}</span></label>
    <label className="preference-check"><input type="checkbox" disabled={!ready} checked={preferences.recentQueries} onChange={(e) => change({ recentQueries: e.target.checked })} /><span>{t('ux.preferences.recent')}</span></label>
    <p className="preference-hint">{t('ux.preferences.recentHint')}</p>
    {error && <div className="preference-error" role="alert"><p>{t('ux.preferences.error', { detail: error })}</p>{!ready && <button type="button" className="btn" onClick={() => void initializeUiPreferences().catch(() => {})}>{t('ux.preferences.retry')}</button>}</div>}
  </div>;
}
