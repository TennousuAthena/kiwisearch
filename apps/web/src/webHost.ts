import { parseAcademicLanguage } from '@kiwi-search/app/academicLanguage';
import type { KiwiHost } from '@kiwi-search/app';
import type { BridgeClient, DomainPreferenceUndo, PreferenceValues } from '@kiwi-search/protocol';

/** Runs at most `limit` of the given jobs at a time; the rest wait their turn. */
export function createQueue(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const next = () => {
    if (active >= limit) return;
    const start = waiting.shift();
    if (start) { active++; start(); }
  };
  return <T>(job: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    waiting.push(() => { job().then(resolve, reject).finally(() => { active--; next(); }); });
    next();
  });
}

/**
 * The search interface on the website: every call the page makes goes to the extension over the bridge. The page has no other way
 * to anything outside itself.
 */
export function createWebHost(client: BridgeClient, location: Pick<Location, 'origin'> = window.location): KiwiHost {
  // A results page asks for many icons at once; the relay answers "busy" beyond 16 requests in flight, and a missed icon is kept as missed.
  const icons = createQueue(6);
  const quiet = (work: Promise<unknown>) => { work.catch(() => {}); };
  return {
    connect: (name) => client.connect(name),
    favicon: (host) => icons(async () => (await client.request<{ src?: string | null }>('favicon', { host })).src ?? null),
    focusWorker: (source) => quiet(client.request('focusWorker', { source })),
    domainPreference: async (action, domain) => (await client.request<{ undo: DomainPreferenceUndo }>('domainPreference', { action, domain })).undo,
    undoDomainPreference: async (undo) => (await client.request<{ restored?: boolean }>('undoDomainPreference', { undo })).restored === true,
    preferences: {
      load: async () => (await client.request<{ values: PreferenceValues }>('prefs.load')).values,
      save: async (values) => { await client.request('prefs.save', { values }); },
      subscribe: (listener) => client.onPush((name, data) => {
        if (name === 'prefs' && data && typeof data === 'object' && !Array.isArray(data)) listener(data as PreferenceValues);
      }),
    },
    academicLanguage: {
      load: async () => parseAcademicLanguage((await client.request<{ language?: unknown }>('academicLanguage.load')).language),
      save: async (language) => { await client.request('academicLanguage.save', { language }); },
    },
    homeUrl: `${location.origin}/`,
    // The settings are a page of the extension; the website cannot link to it, so its links ask the extension to open it.
    optionsUrl: '#',
    openOptions: (section) => quiet(client.request('openOptions', section ? { section } : undefined)),
    urlStyle: 'hash',
  };
}
