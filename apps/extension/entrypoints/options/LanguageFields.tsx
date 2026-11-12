import { OVERVIEW_LANGUAGES, type FusionConfig } from '@kiwi-search/core';
import { useMemo } from 'react';
import { t } from '@/lib/i18n';
import { browserLanguage, builtinModelWrites, languageLabel } from '@/lib/language';
import { Field } from './controls';

interface Props {
  summary: FusionConfig['summary'];
  onChange: (patch: Partial<FusionConfig['summary']>) => void;
}

/** What language the AI overview is written in: the browser's (the default), the query's, one picked from the list, or one the user names. */
export function LanguageFields({ summary, onChange }: Props) {
  const browserTag = useMemo(() => browserLanguage(), []);
  const browserName = browserTag ? languageLabel(browserTag) : undefined;
  const { language, languageCustom } = summary;
  const picked = OVERVIEW_LANGUAGES.find((entry) => entry.tag === language);
  const hint =
    language === 'browser'
      ? browserName
        ? t('options.language.hintBrowser', { language: browserName })
        : t('options.language.hintBrowserUnknown')
      : language === 'auto'
        ? t('options.language.hintAuto')
        : picked
          ? t('options.language.hintPicked', { language: picked.label })
          : undefined;
  // Only when the built-in model is the one writing: it takes five languages.
  const unsupported = summary.provider === 'chrome-builtin' && builtinModelWrites(language, languageCustom, browserTag) === false;

  return (
    <>
      <Field label={t('options.language.label')} hint={hint}>
        <select value={language} onChange={(event) => onChange({ language: event.target.value })}>
          <option value="browser">{browserName ? t('options.language.optionBrowser', { language: browserName }) : t('options.language.optionBrowserUnknown')}</option>
          <option value="auto">{t('options.language.optionAuto')}</option>
          <optgroup label={t('options.language.optionGroup')}>
            {OVERVIEW_LANGUAGES.map((entry) => (
              <option key={entry.tag} value={entry.tag}>
                {entry.label}
              </option>
            ))}
          </optgroup>
          <option value="custom">{t('options.language.optionCustom')}</option>
        </select>
      </Field>
      {language === 'custom' && (
        <Field
          label={t('options.language.customLabel')}
          hint={languageCustom.trim() ? t('options.language.customHint') : t('options.language.customHintEmpty')}
        >
          <input value={languageCustom} maxLength={40} placeholder={t('options.language.customPlaceholder')} spellCheck={false} onChange={(event) => onChange({ languageCustom: event.target.value })} />
        </Field>
      )}
      {unsupported && (
        <p className="notice" role="status">
          {t('options.language.unsupported')}
        </p>
      )}
    </>
  );
}
