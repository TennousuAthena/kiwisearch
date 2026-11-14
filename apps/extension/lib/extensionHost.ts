import type { KiwiHost, PreferenceBackend } from '@kiwi-search/app';
import { parseAcademicLanguage } from '@kiwi-search/app/academicLanguage';
import { observedKeys, preferenceValues } from '@kiwi-search/app/uiPreferences';
import { browser } from 'wxt/browser';
import { undoDomainPreference, updateDomainPreference } from './configUpdates';

const ACADEMIC_LANGUAGE_KEY = 'academicLanguage';

/** The interface preferences, kept in `storage.local` under their own keys, apart from `config`. */
export function createExtensionPreferenceBackend(): PreferenceBackend {
  return {
    load: async () => preferenceValues(await browser.storage.local.get(observedKeys)),
    save: (values) => browser.storage.local.set(values),
    subscribe: (listener) => {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !observedKeys.some((key) => key in changes)) return;
        listener(preferenceValues(Object.fromEntries(observedKeys.filter((key) => key in changes).map((key) => [key, changes[key].newValue]))));
      });
    },
  };
}

/** The search interface running as a page of the extension: the same calls it made before it moved to its own package. */
export function createExtensionHost(): KiwiHost {
  return {
    connect: (name) => browser.runtime.connect({ name }),
    favicon: async (host) => {
      const reply = await (browser.runtime.sendMessage({ type: 'kiwi:favicon', host }) as Promise<{ src?: string | null } | undefined>);
      return reply?.src ?? null;
    },
    focusWorker: (source) => void browser.runtime.sendMessage({ type: 'kiwi:focus-worker', source }),
    domainPreference: updateDomainPreference,
    undoDomainPreference,
    preferences: createExtensionPreferenceBackend(),
    // What the academic tab last chose. Kept apart from `config`, so the settings page, which saves the whole config, can't overwrite it.
    academicLanguage: {
      load: async () => parseAcademicLanguage((await browser.storage.local.get(ACADEMIC_LANGUAGE_KEY))[ACADEMIC_LANGUAGE_KEY]),
      save: (language) => browser.storage.local.set({ [ACADEMIC_LANGUAGE_KEY]: language }),
    },
    homeUrl: browser.runtime.getURL('/app.html'),
    optionsUrl: browser.runtime.getURL('/options.html'),
    // The same address form as the website, so a search is the same address on either.
    urlStyle: 'hash',
  };
}
