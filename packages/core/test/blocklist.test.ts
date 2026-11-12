import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  RECOMMENDED_BLOCKLISTS,
  activeSubscriptions,
  compileBlocklist,
  emptyRules,
  isSubscriptionUrl,
  loadBlocklist,
  parseBlocklist,
} from '../src/blocklist';
import { DEFAULT_CONFIG } from '../src/config';
import type { BlockRules, BlocklistSettings, Env, NamedBlockRules } from '../src/types';

const excerpts = readFileSync(new URL('./fixtures/blocklist-excerpts.txt', import.meta.url), 'utf8');

const rulesOf = (text: string): BlockRules => parseBlocklist(text).rules;
const named = (text: string, name = 'L'): NamedBlockRules => ({ id: name, name, rules: rulesOf(text) });
/** The name of the list that hides `url`, if any. */
const hiddenBy = (text: string, url: string) => compileBlocklist([named(text)])?.match(url, new URL(url).hostname);

describe('parseBlocklist', () => {
  it('reads the shapes found in real lists (Content Farm Terminator, uBlacklist compilation, AI uBlock Blacklist, BadWebsiteBlocklist)', () => {
    const { rules, stats } = parseBlocklist(excerpts);
    expect(rules.block.sites.sort()).toEqual(['001553.cn', '0099033.com', '03tity.me', '165.227.24.198', 'soundscapehq.com', 'solveyourtech.com'].sort());
    expect(rules.block.hosts).toEqual(['114.55.26.126']);
    expect(rules.block.patterns).toHaveLength(10);
    expect(rules.allow).toEqual({ sites: ['gov.cn'], hosts: ['landiannews.com', 'answers.microsoft.com'], patterns: [] });
    // Page-element filters are not a problem; the rest are lines that look like rules but cannot be used.
    expect(stats).toMatchObject({ rules: 20, cosmetic: 2, unsupported: 6 });
    expect(stats.examples).toHaveLength(3);
  });

  it('leaves out rules that would hide ordinary pages: a regex that only describes the shape of an address, a rule on every host', () => {
    const { rules, stats } = parseBlocklist(['/.*\\/(.*)(s|q)=.*/', '*://*/search/*', '|http://', '*://*/*', '*.com', '/\\.com/'].join('\n'));
    expect(rules.block).toEqual({ sites: [], hosts: [], patterns: [] });
    expect(stats.unsupported).toBe(6);
  });

  it('reads plain domains, subdomain notation, wildcard hosts and hosts-file lines', () => {
    const { rules } = parseBlocklist(
      ['example.com', 'WWW.Shouting.COM', '*.sub.example.net', '.dot.example.org', 'with.comment.com  # why', '0.0.0.0 hosts.example.com', '127.0.0.1 localhost', 'foo.blogspot.*', 'path.example.com/news'].join('\n'),
    );
    expect(rules.block.sites).toEqual(['example.com', 'shouting.com', 'sub.example.net', 'dot.example.org', 'with.comment.com', 'hosts.example.com']);
    expect(rules.block.patterns).toHaveLength(2);
    expect(hiddenBy('foo.blogspot.*', 'https://foo.blogspot.com.au/x')).toBe('L');
    expect(hiddenBy('foo.blogspot.*', 'https://notfoo.blogspot.com/x')).toBeUndefined();
    expect(hiddenBy('path.example.com/news', 'https://path.example.com/news/today')).toBe('L');
    expect(hiddenBy('path.example.com/news', 'https://path.example.com/about')).toBeUndefined();
  });

  it('reads uBlock Origin / Adblock Plus network filters, including the options that still mean "this page"', () => {
    const { rules, stats } = parseBlocklist(
      [
        '[Adblock Plus 2.0]',
        '! a comment',
        '||plain.example.com^',
        '||doc.example.com^$doc',
        '||annotated.example.com^$doc,reason="AI slop, scraped"',
        '||all.example.com^$all,important',
        '||third.example.com^$third-party',
        '||script.example.com^$script,doc',
        '||withpath.example.com/blog/',
        '|https://exact.example.com/page',
      ].join('\n'),
    );
    expect(rules.block.sites).toEqual(['plain.example.com', 'doc.example.com', 'annotated.example.com', 'all.example.com']);
    expect(rules.block.patterns).toHaveLength(2);
    // `$third-party` and `$script` are about requests, not about a page a search can return.
    expect(stats.unsupported).toBe(2);
    // A path is a prefix; `^` is a separator (anything but a letter, digit, `_`, `-`, `.`, `%`, or the end), so it stops `/blog` matching `/blogger`.
    expect(hiddenBy('||withpath.example.com/blog/', 'https://withpath.example.com/blog/post')).toBe('L');
    expect(hiddenBy('||withpath.example.com/blog^', 'https://withpath.example.com/blog/post')).toBe('L');
    expect(hiddenBy('||withpath.example.com/blog^', 'https://withpath.example.com/blog?page=2')).toBe('L');
    expect(hiddenBy('||withpath.example.com/blog^', 'https://withpath.example.com/blogger')).toBeUndefined();
    expect(hiddenBy('||withpath.example.com/blog/^', 'https://withpath.example.com/blog/post')).toBeUndefined();
    expect(hiddenBy('|https://exact.example.com/page', 'https://exact.example.com/page/2')).toBe('L');
    expect(hiddenBy('|https://exact.example.com/page', 'http://exact.example.com/page')).toBeUndefined();
  });

  it('reads uBlacklist match patterns: a site with subdomains, one exact host, a section of a site', () => {
    const text = ['*://*.deep.example.com/*', '*://news.example.com/*', '*://*.example.org/blog/*', '*://*.example.org/*/guide/*', 'https://only.example.net/*', 'ftp://old.example.com/*'].join('\n');
    const { rules, stats } = parseBlocklist(text);
    expect(rules.block.sites).toEqual(['deep.example.com']);
    expect(rules.block.hosts).toEqual(['news.example.com']);
    expect(stats.unsupported).toBe(1);
    expect(hiddenBy(text, 'https://a.b.deep.example.com/x')).toBe('L');
    expect(hiddenBy(text, 'https://news.example.com/x')).toBe('L');
    expect(hiddenBy(text, 'https://www.news.example.com/x')).toBe('L');
    expect(hiddenBy(text, 'https://a.news.example.com/x')).toBeUndefined();
    expect(hiddenBy(text, 'https://example.com/x')).toBeUndefined();
    expect(hiddenBy(text, 'https://example.org/blog/post?x=1')).toBe('L');
    expect(hiddenBy(text, 'https://example.org/about')).toBeUndefined();
    expect(hiddenBy(text, 'https://example.org/a/guide/b')).toBe('L');
    expect(hiddenBy(text, 'https://only.example.net/x')).toBe('L');
    expect(hiddenBy(text, 'http://only.example.net/x')).toBeUndefined();
  });

  it('skips a uBlacklist header block, comments, blank lines and page-element filters without counting them as problems', () => {
    const { rules, stats } = parseBlocklist(['', '---', 'name: Some list', 'homepage: https://example.com', '---', '# note', '', 'a.example.com', '##.ad', 'b.example.com#@#.ad', 'c.example.com##.promo'].join('\n'));
    expect(rules.block.sites).toEqual(['a.example.com']);
    expect(stats).toMatchObject({ rules: 1, cosmetic: 3, unsupported: 0 });
  });

  it('keeps regular expressions that name a site and drops risky or over-broad ones', () => {
    const accepted = ['/example\\.com/', '/^https?://(?:[\\w-]+\\.)+example\\.com//', '/^https?:\\/\\/blog\\.example\\.com\\/(?:alice|bob)(?=[/?#]|$)/i', '/example\\.com/  # with a trailing comment'];
    for (const line of accepted) expect(rulesOf(line).block.patterns, line).toHaveLength(1);
    const rejected = [
      '/(a+)+example\\.com/', // catastrophic backtracking
      '/(.*)*example\\.com/',
      '/(a)\\1example\\.com/', // backreference
      '/(?:one|two|three)\\.(?:com|org|co\\.uk)/', // matches unrelated sites
      '/^https?:\\/\\//',
      `/${'a'.repeat(450)}\\.com/`,
      '/(unclosed/',
    ];
    for (const line of rejected) expect(rulesOf(line).block.patterns, line).toHaveLength(0);
  });

  it('reads exceptions in both syntaxes', () => {
    const { rules } = parseBlocklist(['@@||ok.example.com^', '@*://*.gov.cn/*', '@*://www.docs.example.net/*', '@@||ok.example.com/path^'].join('\n'));
    expect(rules.allow.sites).toEqual(['ok.example.com', 'gov.cn']);
    expect(rules.allow.hosts).toEqual(['docs.example.net']);
    expect(rules.allow.patterns).toHaveLength(1);
    expect(rules.block).toEqual(emptyRules().block);
  });

  it('turns internationalized names into their ASCII form and tolerates CRLF', () => {
    expect(rulesOf('*://*.bücher.example/*\r\nplain.example.com\r\n').block.sites).toEqual(['xn--bcher-kva.example', 'plain.example.com']);
  });

  it('is not slowed down by a very long line', () => {
    const { stats } = parseBlocklist(`${'a'.repeat(100_000)}.com\nfine.example.com`);
    expect(stats).toMatchObject({ rules: 1, unsupported: 1 });
  });

  it('removes repeats', () => {
    expect(parseBlocklist(['a.example.com', '*://*.a.example.com/*', '||a.example.com^', '.a.example.com'].join('\n')).stats.rules).toBe(1);
  });
});

describe('compileBlocklist', () => {
  it('hides a site and its subdomains but not look-alikes', () => {
    const list = compileBlocklist([named('spamsite.com')])!;
    for (const host of ['spamsite.com', 'www.spamsite.com', 'blog.spamsite.com', 'A.B.SPAMSITE.COM']) expect(list.match(`https://${host}/x`, host), host).toBe('L');
    for (const host of ['notspamsite.com', 'spamsite.com.evil.net', 'com']) expect(list.match(`https://${host}/x`, host), host).toBeUndefined();
  });

  it('lets an exception in any list beat a block in any list', () => {
    const lists = [named('*://*.example.com/*', 'farm'), named('@*://docs.example.com/*', 'mine')];
    const list = compileBlocklist(lists)!;
    expect(list.match('https://blog.example.com/a', 'blog.example.com')).toBe('farm');
    expect(list.match('https://docs.example.com/a', 'docs.example.com')).toBeUndefined();
    expect(list.match('https://www.docs.example.com/a', 'www.docs.example.com')).toBeUndefined();
    // Only the whole host is excepted: a deeper subdomain is still blocked.
    expect(list.match('https://x.docs.example.com/a', 'x.docs.example.com')).toBe('farm');
  });

  it('names the first list that hides the address', () => {
    const list = compileBlocklist([named('one.example.com', 'first'), named('two.example.com\none.example.com', 'second')])!;
    expect(list.match('https://one.example.com/', 'one.example.com')).toBe('first');
    expect(list.match('https://two.example.com/', 'two.example.com')).toBe('second');
  });

  it('is undefined when there is nothing to block with', () => {
    expect(compileBlocklist([])).toBeUndefined();
    expect(compileBlocklist([named('# only a comment')])).toBeUndefined();
    expect(compileBlocklist([named('@@||only.example.com^')])).toBeUndefined();
  });

  it('answers the same for a repeated address and tolerates an enormous one', () => {
    const list = compileBlocklist([named('/^https?://(?:blog|album)\\.udn\\.com/(?:mobile/)?(?:a94xpv)(?=[/?#]|$)/')])!;
    const url = 'https://blog.udn.com/a94xpv/1';
    expect(list.match(url, 'blog.udn.com')).toBe('L');
    expect(list.match(url, 'blog.udn.com')).toBe('L');
    const started = performance.now();
    expect(list.match(`https://blog.udn.com/x/${'a'.repeat(200_000)}`, 'blog.udn.com')).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('keeps a mixed set of real-list shapes working together', () => {
    const list = compileBlocklist([named(excerpts, 'real')])!;
    const hidden = (url: string) => list.match(url, new URL(url).hostname);
    expect(hidden('https://tw.y2mate.com/en/x')).toBe('real');
    expect(hidden('https://www.y2mate.com/en/x')).toBeUndefined(); // the list's own regex leaves `www.` alone
    expect(hidden('https://blog.udn.com/a94xpv/1')).toBe('real');
    expect(hidden('https://blog.udn.com/somebody/1')).toBeUndefined();
    expect(hidden('https://against24.blogspot.com.au/2020/x')).toBe('real');
    expect(hidden('https://x.com/Clie_X/status/1')).toBe('real');
    expect(hidden('https://x.com/someone/status/1')).toBeUndefined();
    expect(hidden('https://www.earthweb.com/blog/post')).toBe('real');
    expect(hidden('https://www.earthweb.com/about')).toBeUndefined();
    expect(hidden('https://shop.nordvpn.com/en/blog/x')).toBe('real');
    expect(hidden('https://114.55.26.126/page')).toBe('real');
    expect(hidden('https://www.soundscapehq.com/post')).toBe('real');
    expect(hidden('https://www.gov.cn/policy')).toBeUndefined();
    expect(hidden('https://en.wikipedia.org/wiki/Cat')).toBeUndefined();
  });
});

describe('loadBlocklist', () => {
  const settings = (custom = ''): BlocklistSettings => ({ recommended: [], subscriptions: [], custom });
  const configWith = (custom: string) => ({ ...DEFAULT_CONFIG, judge: { ...DEFAULT_CONFIG.judge, blocklists: settings(custom) } });
  const noFetch: Env['fetch'] = async () => new Response('');

  it('combines the subscribed lists the caller kept with the user\'s own rules', async () => {
    const env: Env = { fetch: noFetch, loadBlocklists: async () => [named('subscribed.example.com', '订阅')] };
    const list = await loadBlocklist(configWith('mine.example.com'), env);
    expect(list?.match('https://subscribed.example.com/', 'subscribed.example.com')).toBe('订阅');
    expect(list?.match('https://mine.example.com/', 'mine.example.com')).toBe('自定义规则');
  });

  it('gives the user\'s rules when the caller keeps no lists, and nothing when there is nothing', async () => {
    expect(await loadBlocklist(configWith('mine.example.com'), { fetch: noFetch })).toBeDefined();
    expect(await loadBlocklist(configWith('  \n'), { fetch: noFetch })).toBeUndefined();
  });

  it('carries on without subscribed lists when reading them fails', async () => {
    const env: Env = {
      fetch: noFetch,
      loadBlocklists: async () => {
        throw new Error('storage unavailable');
      },
    };
    const list = await loadBlocklist(configWith('mine.example.com'), env);
    expect(list?.match('https://mine.example.com/', 'mine.example.com')).toBe('自定义规则');
  });
});

describe('subscriptions', () => {
  it('accepts https addresses, and http only for this machine', () => {
    expect(isSubscriptionUrl('https://example.com/list.txt')).toBe(true);
    expect(isSubscriptionUrl(' https://example.com/list.txt ')).toBe(true);
    expect(isSubscriptionUrl('http://localhost:8080/list.txt')).toBe(true);
    expect(isSubscriptionUrl('http://127.0.0.1/list.txt')).toBe(true);
    for (const url of ['http://example.com/list.txt', 'ftp://example.com/list.txt', 'file:///etc/hosts', 'javascript:alert(1)', 'example.com/list.txt', '']) expect(isSubscriptionUrl(url), url).toBe(false);
  });

  it('lists what to keep fetched: recommended ones that are on, and the user\'s own that are on and usable', () => {
    const [first, second] = RECOMMENDED_BLOCKLISTS;
    const active = activeSubscriptions({
      recommended: [second.id, 'a-list-that-was-removed'],
      subscriptions: [
        { id: 's1', name: ' 我的列表 ', url: 'https://lists.example.com/a.txt', enabled: true },
        { id: 's2', name: '', url: 'https://lists.example.com/b.txt', enabled: true },
        { id: 's3', name: 'off', url: 'https://lists.example.com/c.txt', enabled: false },
        { id: 's4', name: 'bad address', url: 'http://lists.example.com/d.txt', enabled: true },
      ],
      custom: '',
    });
    expect(active).toEqual([
      { id: second.id, name: second.name, url: second.url },
      { id: 's1', name: '我的列表', url: 'https://lists.example.com/a.txt' },
      { id: 's2', name: 'lists.example.com', url: 'https://lists.example.com/b.txt' },
    ]);
    expect(active.some((entry) => entry.id === first.id)).toBe(false);
  });

  it('ships a catalog of https lists with distinct ids', () => {
    const ids = RECOMMENDED_BLOCKLISTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of RECOMMENDED_BLOCKLISTS) {
      expect(isSubscriptionUrl(entry.url), entry.id).toBe(true);
      expect(entry.url.startsWith('https://'), entry.id).toBe(true);
      expect([entry.name, entry.description, entry.license, entry.homepage].every(Boolean), entry.id).toBe(true);
    }
  });
});
