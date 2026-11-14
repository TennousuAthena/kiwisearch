import { describe, expect, it } from 'vitest';
import { REDIRECT_RULE_IDS, searchRedirectRules } from '../lib/searchRedirect';

const APP = 'chrome-extension://abc/app.html';

/** What `declarativeNetRequest` would do with an address: the highest-priority rule whose regular expression matches, with `\1` filled in. */
function redirected(rules: ReturnType<typeof searchRedirectRules>, url: string): string | null {
  const hits = rules.filter((rule) => new RegExp(rule.condition.regexFilter).test(url)).sort((a, b) => b.priority - a.priority);
  const rule = hits[0];
  if (!rule) return null;
  const groups = new RegExp(rule.condition.regexFilter).exec(url)!;
  return rule.action.redirect.regexSubstitution.replace(/\\(\d)/g, (_, n) => groups[Number(n)] ?? '');
}

const OLD_HOST_CASES: Array<[string, string]> = [
  ['https://s.kiwi.moe/s?q=hello+world', `${APP}?q=hello+world`],
  ['https://s.kiwi.moe/s?q=a%26b+c&m=news', `${APP}?q=a%26b+c&m=news`],
  ['https://s.kiwi.moe/#q=hello%20world', `${APP}#q=hello%20world`],
  ['https://s.kiwi.moe/', APP],
];

describe('the old host s.kiwi.moe, in both modes', () => {
  for (const source of ['site', 'local'] as const) {
    it(`opens the extension's own interface while the interface comes from ${source === 'site' ? 'the website' : 'the extension'}, so a default search added from the first documents keeps working`, () => {
      const rules = searchRedirectRules(source, APP);
      for (const [url, target] of OLD_HOST_CASES) expect(redirected(rules, url), url).toBe(target);
    });
  }
});

describe('while the interface comes from the website', () => {
  const rules = searchRedirectRules('site', APP);

  it('leaves every address of kiwi.moe to the website', () => {
    for (const url of ['https://kiwi.moe/', 'https://kiwi.moe/#q=x', 'https://kiwi.moe/install', 'https://kiwi.moe/s?q=x']) expect(redirected(rules, url), url).toBeNull();
  });
});

describe('while the interface comes from the extension itself', () => {
  const rules = searchRedirectRules('local', APP);

  it('opens the extension page for the search page of the website, so the browser never contacts it for a search', () => {
    expect(redirected(rules, 'https://kiwi.moe/#q=hello%20world')).toBe(`${APP}#q=hello%20world`);
    expect(redirected(rules, 'https://kiwi.moe/#m=news&q=a&b')).toBe(`${APP}#m=news&q=a&b`);
    expect(redirected(rules, 'https://kiwi.moe/')).toBe(APP);
    expect(redirected(rules, 'https://kiwi.moe')).toBe(APP);
  });

  it('lets the other pages of the site load, and does not touch other hosts, including lookalikes', () => {
    for (const url of ['https://kiwi.moe/install', 'https://kiwi.moe/privacy', 'https://kiwi.moe/en/about', 'https://kiwi.moe/s?q=x', 'https://www.kiwi.moe/#q=x', 'https://evil.example/#q=x',
      'https://kiwi.moe.evil.example/#q=x', 'https://evilkiwi.moe/#q=x', 'http://kiwi.moe/#q=x', 'https://u.kiwi.moe/#q=x']) {
      expect(redirected(rules, url), url).toBeNull();
    }
  });
});

describe('the rules', () => {
  it('only ever touch the top-level page, and own a fixed set of ids that the next registration replaces', () => {
    for (const source of ['site', 'local'] as const) {
      const rules = searchRedirectRules(source, APP);
      expect(rules.every((rule) => rule.condition.resourceTypes.length === 1 && rule.condition.resourceTypes[0] === 'main_frame')).toBe(true);
      expect(rules.every((rule) => (REDIRECT_RULE_IDS as readonly number[]).includes(rule.id))).toBe(true);
      expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
    }
  });
});
