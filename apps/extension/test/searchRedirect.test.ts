import { readPageParams } from '@kiwi-search/app/pageLocation';
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

describe('while the interface comes from the website', () => {
  const rules = searchRedirectRules('site', APP);

  it('rewrites the old address to the fragment form in the browser, so the query is not sent', () => {
    expect(redirected(rules, 'https://s.kiwi.moe/s?q=hello+world')).toBe('https://s.kiwi.moe/#legacy=1&q=hello+world');
    const target = new URL(redirected(rules, 'https://s.kiwi.moe/s?q=a%26b+c&m=news')!);
    expect(Object.fromEntries(readPageParams({ search: target.search, hash: target.hash }))).toEqual({ q: 'a&b c', m: 'news' });
  });

  it('leaves everything else to the website', () => {
    for (const url of ['https://s.kiwi.moe/', 'https://s.kiwi.moe/#q=x', 'https://s.kiwi.moe/other', 'https://s.kiwi.moe/s?q=x#frag', 'https://evil.example/s?q=x', 'https://s.kiwi.moe.evil.example/s?q=x', 'http://s.kiwi.moe/s?q=x', 'https://sxkiwi.moe/s?q=x']) {
      expect(redirected(rules, url), url).toBeNull();
    }
  });
});

describe('while the interface comes from the extension itself', () => {
  const rules = searchRedirectRules('local', APP);

  it('opens the extension page for every address of the website, so the browser never contacts it', () => {
    expect(redirected(rules, 'https://s.kiwi.moe/#q=hello%20world')).toBe(`${APP}#q=hello%20world`);
    expect(redirected(rules, 'https://s.kiwi.moe/#m=news&q=a&b')).toBe(`${APP}#m=news&q=a&b`);
    expect(redirected(rules, 'https://s.kiwi.moe/s?q=hello+world')).toBe(`${APP}?q=hello+world`);
    expect(redirected(rules, 'https://s.kiwi.moe/')).toBe(APP);
    expect(redirected(rules, 'https://s.kiwi.moe')).toBe(APP);
  });

  it('does not touch other hosts, including lookalikes', () => {
    for (const url of ['https://kiwi.moe/#q=x', 'https://evil.example/#q=x', 'https://s.kiwi.moe.evil.example/#q=x', 'http://s.kiwi.moe/#q=x', 'https://s.kiwi.moe/other']) {
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
