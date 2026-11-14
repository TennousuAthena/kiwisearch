import type { UiSource } from './uiSource';

/** The rule ids this file owns; they are removed and added together, so a rule of an older version never stays behind. */
export const REDIRECT_RULE_IDS = [1001, 1002, 1003, 1004, 1005] as const;

export interface RedirectRule {
  id: number;
  priority: number;
  action: { type: 'redirect'; redirect: { regexSubstitution: string } };
  condition: { regexFilter: string; resourceTypes: ['main_frame'] };
}

const SITE = 'https://kiwi\\.moe';
/** The host the first documents told users to add as their default search (`https://s.kiwi.moe/s?q=%s`). It was never hosted. */
const OLD_SITE = 'https://s\\.kiwi\\.moe';

/**
 * What the browser does, by itself, with an address of the Kiwi website before any request is made (a redirect by `declarativeNetRequest`
 * happens before the network, checked in Chromium 156: the server saw nothing).
 *
 * - Always: the old host `s.kiwi.moe` opens the extension's own interface, so a default search added from the first documents keeps working.
 * - `site`: nothing else; the website loads.
 * - `local`: the search page of `kiwi.moe` (its root, with or without a `#…`) opens the extension's own interface instead, so the browser never
 *   contacts the website for a search. The other pages of the site (introduction, install, privacy) load as usual.
 */
export function searchRedirectRules(source: UiSource, appUrl: string): RedirectRule[] {
  const rule = (id: number, priority: number, regexFilter: string, regexSubstitution: string): RedirectRule => ({
    id, priority, action: { type: 'redirect', redirect: { regexSubstitution } }, condition: { regexFilter, resourceTypes: ['main_frame'] },
  });
  const old = [
    rule(1001, 2, `^${OLD_SITE}/s\\?([^#]*)$`, `${appUrl}?\\1`),
    rule(1002, 1, `^${OLD_SITE}/#(.*)$`, `${appUrl}#\\1`),
    rule(1003, 1, `^${OLD_SITE}/?$`, appUrl),
  ];
  if (source === 'site') return old;
  return [...old, rule(1004, 1, `^${SITE}/#(.*)$`, `${appUrl}#\\1`), rule(1005, 1, `^${SITE}/?$`, appUrl)];
}
