import type { UiSource } from './uiSource';

/** The rule ids this file owns; they are removed and added together, so a rule of an older version never stays behind. */
export const REDIRECT_RULE_IDS = [1001, 1002, 1003] as const;

export interface RedirectRule {
  id: number;
  priority: number;
  action: { type: 'redirect'; redirect: { regexSubstitution: string } };
  condition: { regexFilter: string; resourceTypes: ['main_frame'] };
}

const SITE = 'https://s\\.kiwi\\.moe';

/**
 * What the browser does, by itself, with an address on the Kiwi website before any request is made (a redirect by `declarativeNetRequest`
 * happens before the network, checked in Chromium 156: the server saw nothing).
 *
 * - `site`: the old address `/s?q=…` becomes the fragment form, so the query is not sent. Everything else loads the website.
 * - `local`: every main-frame address of the website opens the extension's own interface instead, so the browser never contacts the website.
 */
export function searchRedirectRules(source: UiSource, appUrl: string): RedirectRule[] {
  const rule = (id: number, priority: number, regexFilter: string, regexSubstitution: string): RedirectRule => ({
    id, priority, action: { type: 'redirect', redirect: { regexSubstitution } }, condition: { regexFilter, resourceTypes: ['main_frame'] },
  });
  if (source === 'site') return [rule(1001, 1, `^${SITE}/s\\?([^#]*)$`, 'https://s.kiwi.moe/#legacy=1&\\1')];
  return [
    rule(1001, 2, `^${SITE}/s\\?([^#]*)$`, `${appUrl}?\\1`),
    rule(1002, 1, `^${SITE}/#(.*)$`, `${appUrl}#\\1`),
    rule(1003, 1, `^${SITE}/?$`, appUrl),
  ];
}
