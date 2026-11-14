/**
 * The websites that may talk to the extension. Fixed when the extension is built: nothing the user or a page sends can add to it.
 * A build can add one development origin (`WXT_KIWI_WEB_DEV_ORIGIN=http://localhost:5173 pnpm build`) for working on the website;
 * the store builds are made without it, so they only know the real site.
 */
const DEV_ORIGIN: string | undefined = import.meta.env.WXT_KIWI_WEB_DEV_ORIGIN || undefined;

export const WEB_ORIGINS: readonly string[] = ['https://s.kiwi.moe', ...(DEV_ORIGIN ? [new URL(DEV_ORIGIN).origin] : [])];

/** Match patterns for the content script. A pattern has no port, so a development origin matches on its host. */
export const WEB_MATCHES: string[] = [...new Set(WEB_ORIGINS.map((origin) => { const url = new URL(origin); return `${url.protocol}//${url.hostname}/*`; }))];
