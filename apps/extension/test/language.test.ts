import { describe, expect, it } from 'vitest';
import { BUILTIN_MODEL_LANGUAGES, browserLanguage, builtinModelWrites, languageLabel, pickBrowserLanguage } from '../lib/language';

describe('pickBrowserLanguage', () => {
  it('takes the first language the browser lists, which is the one sites are told first', () => {
    expect(pickBrowserLanguage(['zh-CN', 'en'], 'en-US')).toBe('zh-CN');
    expect(pickBrowserLanguage(['en-GB', 'en-US', 'en'], 'zh-CN')).toBe('en-GB');
  });

  it('falls back to the browser\'s display language, and to nothing', () => {
    expect(pickBrowserLanguage([], 'ja')).toBe('ja');
    expect(pickBrowserLanguage(undefined, ' fr ')).toBe('fr');
    expect(pickBrowserLanguage(['', '  ', 'de'], undefined)).toBe('de');
    expect(pickBrowserLanguage(undefined, undefined)).toBeUndefined();
    expect(pickBrowserLanguage([], '')).toBeUndefined();
  });
});

describe('browserLanguage', () => {
  it('reads the navigator and the extension api of the context it runs in, and says nothing where there is neither', () => {
    const scope = globalThis as Record<string, unknown>;
    const saved = { navigator: Object.getOwnPropertyDescriptor(scope, 'navigator'), chrome: scope.chrome };
    try {
      Object.defineProperty(scope, 'navigator', { value: { languages: ['sv-SE', 'en'], language: 'sv-SE' }, configurable: true });
      scope.chrome = { i18n: { getUILanguage: () => 'en-US' } };
      expect(browserLanguage()).toBe('sv-SE');
      Object.defineProperty(scope, 'navigator', { value: { languages: [], language: 'fi' }, configurable: true });
      expect(browserLanguage()).toBe('fi');
      Object.defineProperty(scope, 'navigator', { value: {}, configurable: true });
      expect(browserLanguage()).toBe('en-US');
      scope.chrome = undefined;
      expect(browserLanguage()).toBeUndefined();
      scope.chrome = { i18n: { getUILanguage: () => { throw new Error('no i18n here'); } } };
      expect(browserLanguage()).toBeUndefined();
    } finally {
      if (saved.navigator) Object.defineProperty(scope, 'navigator', saved.navigator);
      else delete scope.navigator;
      scope.chrome = saved.chrome;
    }
  });
});

describe('languageLabel', () => {
  it('says a language in the words of the settings page', () => {
    expect(languageLabel('zh-CN')).toBe('简体中文');
    expect(languageLabel('zh-Hans-GB')).toBe('简体中文');
    expect(languageLabel('zh-HK')).toBe('繁體中文');
    expect(languageLabel('en-GB')).toBe('English');
    expect(languageLabel('ja')).toBe('日本語');
    expect(languageLabel('sv')).toBe('瑞典语');
    expect(languageLabel(undefined)).toBe('未知');
    expect(languageLabel('  ')).toBe('未知');
  });
});

describe('builtinModelWrites', () => {
  it('knows the five languages Chrome\'s built-in model takes', () => {
    expect(BUILTIN_MODEL_LANGUAGES).toEqual(['en', 'ja', 'es', 'de', 'fr']);
    expect(builtinModelWrites('en', '', 'zh-CN')).toBe(true);
    expect(builtinModelWrites('fr', '', undefined)).toBe(true);
    expect(builtinModelWrites('zh-CN', '', 'en')).toBe(false);
    expect(builtinModelWrites('pt-BR', '', 'en')).toBe(false);
  });

  it('follows the browser\'s language, and a custom one that is a code; it cannot tell for auto or when the browser says nothing', () => {
    expect(builtinModelWrites('browser', '', 'en-GB')).toBe(true);
    expect(builtinModelWrites('browser', '', 'zh-CN')).toBe(false);
    expect(builtinModelWrites('browser', '', undefined)).toBeUndefined();
    expect(builtinModelWrites('auto', '', 'zh-CN')).toBeUndefined();
    expect(builtinModelWrites('custom', 'de', 'zh-CN')).toBe(true);
    expect(builtinModelWrites('custom', 'zh-TW', 'en')).toBe(false);
    // A name is not looked up, so there is no notice for it.
    expect(builtinModelWrites('custom', 'Deutsch', 'en')).toBeUndefined();
    expect(builtinModelWrites('custom', '', 'en')).toBeUndefined();
  });
});
