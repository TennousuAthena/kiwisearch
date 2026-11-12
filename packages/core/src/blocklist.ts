import type { BlockRules, BlockRuleSet, BlocklistSettings, Env, FusionConfig, NamedBlockRules } from './types';

/**
 * Block lists: sites whose results are folded away. A list is plain text in whatever format the community already
 * publishes, read line by line:
 *   - `example.com`, `*.example.com`, `example.com/path`, `foo.blogspot.*`    (plain domains; Content Farm Terminator)
 *   - `0.0.0.0 example.com`                                                    (hosts files)
 *   - `||example.com^`, `||example.com/path^$doc`, `|https://example.com/x`   (uBlock Origin / Adblock Plus network filters)
 *   - `*://*.example.com/*`, `https://example.com/path/*`                      (uBlacklist match patterns)
 *   - `/^https?:\/\/(?:blog|album)\.udn\.com\/…/`                              (regular expressions)
 *   - `@@||example.com^`, `@*://*.gov.cn/*`                                    (exceptions: never hidden by a list)
 * Everything a search result cannot be matched with is skipped: page-element filters (`##`), resource types (`$script`,
 * `$third-party`), comments and headers. A skipped line never fails the list.
 *
 * `www.` is not told apart from the bare domain, as with the user's own site lists.
 */

export interface RecommendedBlocklist {
  id: string;
  name: string;
  /** Where the list is fetched from. */
  url: string;
  homepage: string;
  /** What it covers, in a line. */
  description: string;
  /** The list's own licence, as far as it states one. Lists are fetched by the user's browser, never bundled. */
  license: string;
}

/**
 * Lists the settings page offers. Each address was fetched and parsed when it was added; the lists are not ours and may move.
 * A list belongs here only if it is about low-quality sites. eallion's uBlacklist compilation is deliberately left out: it
 * also carries its author's own taste (all of baidu.com, csdn.net, juejin.cn, amazon.com and sohu.com are in it), so a user
 * who wants it can add it by address.
 */
export const RECOMMENDED_BLOCKLISTS: RecommendedBlocklist[] = [
  {
    id: 'content-farm-terminator',
    name: 'Content Farm Terminator',
    url: 'https://danny0838.github.io/content-farm-terminator/files/blocklist/content-farms.txt',
    homepage: 'https://github.com/danny0838/content-farm-terminator',
    description: '中文内容农场，以繁体中文站点为主；其中有按博客作者屏蔽的规则。',
    license: 'MIT',
  },
  {
    id: 'ai-ublock-blacklist',
    name: 'AI uBlock Blacklist',
    url: 'https://raw.githubusercontent.com/alvi-se/ai-ublock-blacklist/master/list.txt',
    homepage: 'https://github.com/alvi-se/ai-ublock-blacklist',
    description: 'AI 批量生成的垃圾内容站，以英文站点为主。',
    license: 'GPL-3.0',
  },
  {
    id: 'bad-website-blocklist',
    name: 'BadWebsiteBlocklist',
    url: 'https://raw.githubusercontent.com/popcar2/BadWebsiteBlocklist/main/uBlacklist.txt',
    homepage: 'https://github.com/popcar2/BadWebsiteBlocklist',
    description: '拼凑文章、AI 垃圾站和误导性网站，以英文站点为主；有些规则只屏蔽站内某个栏目（如 /blog/）。',
    license: 'CC0',
  },
];

/** A list that is switched on, with where to fetch it from. */
export interface BlocklistSource {
  id: string;
  name: string;
  url: string;
}

/** Subscriptions go over https; plain http is accepted only for a list served from this machine. */
export function isSubscriptionUrl(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The lists to keep fetched: the recommended ones that are switched on, and the user's own that are switched on and have a usable address. */
export function activeSubscriptions(settings: BlocklistSettings): BlocklistSource[] {
  const out: BlocklistSource[] = [];
  for (const entry of RECOMMENDED_BLOCKLISTS) {
    if (settings.recommended.includes(entry.id)) out.push({ id: entry.id, name: entry.name, url: entry.url });
  }
  for (const sub of settings.subscriptions) {
    if (!sub.enabled || !isSubscriptionUrl(sub.url)) continue;
    out.push({ id: sub.id, name: sub.name.trim() || new URL(sub.url).hostname, url: sub.url.trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsing

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$/;
const MAX_LINE = 1000;
const MAX_REGEX = 400;
/** Options of a uBlock Origin / Adblock Plus filter that still mean "this page": anything else (`$script`, `$third-party`, …) is about requests. `reason` is an annotation (the AI uBlock Blacklist writes one on every line). */
const PAGE_OPTIONS = new Set(['all', 'doc', 'document', 'important', 'reason']);
/** A regular expression must name a site (`example.com`, `example\.com`); one that only describes the shape of an address would hide ordinary pages. */
const NAMES_A_SITE = /[a-z0-9-]{2,}\\?\.[a-z]{2,}/i;
/** The classic catastrophic shape, a quantified group that ends in a quantifier and is itself quantified (`(a+)+`), and backreferences. */
const RISKY_REGEX = /(?<!\\)[+*}]\)[+*{]|\\[1-9]/;
/** A rule that matches two of these is too broad to be a site rule. */
const PROBES = ['https://kiwi-probe-one.com/', 'https://www.kiwi-probe-two.org/news/page?id=3', 'http://docs.kiwi-probe-three.co.uk/a/b.html'];

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Lower-case ASCII host name without `www.` (or an IPv4 address), or undefined when `input` isn't a host name. */
function cleanHost(input: string): string | undefined {
  let host = input.toLowerCase().replace(/\.$/, '');
  if (IPV4.test(host)) return host;
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      host = new URL(`http://${host}`).hostname;
    } catch {
      return undefined;
    }
  }
  host = host.replace(/^www\./, '');
  return HOST.test(host) ? host : undefined;
}

/** A host with `*` in it (`foo.blogspot.*`): only when what is left of it still names something. */
function wildcardHost(input: string): string | undefined {
  const host = input.toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9*][a-z0-9*._-]*$/.test(host) || !host.includes('.')) return undefined;
  return host.replace(/[*.]/g, '').length >= 5 ? host : undefined;
}

const hostOrPattern = (host: string) => (host.includes('*') ? wildcardHost(host) : cleanHost(host));

function hostSource(host: string, subdomains: boolean): string {
  return (subdomains ? '(?:[^/?#@]*\\.)?' : '(?:www\\.)?') + host.split('*').map(escapeRe).join('[^/?#]*');
}

/** Adblock syntax: `*` is anything, `^` a separator (anything but a letter, digit, `_`, `-`, `.`, `%`, or the end), a trailing `|` the end. */
function abpSource(pattern: string): string {
  const end = pattern.endsWith('|');
  const body = end ? pattern.slice(0, -1) : pattern;
  let out = '';
  for (const ch of body) out += ch === '*' ? '.*' : ch === '^' ? '(?:[^\\w.%-]|$)' : escapeRe(ch);
  return out + (end ? '$' : '');
}

const HOST_END = '(?=[/?#:]|$)';

/**
 * A regular expression the search may use against an address: bounded in size and shape, and not matching everything.
 * `written` ones (from a list's own `/…/` line, or a `|` filter) must also name a site; the ones built here from a checked host do.
 */
function usableRegex(source: string, written: boolean): boolean {
  if (source.length > MAX_REGEX || RISKY_REGEX.test(source) || (written && !NAMES_A_SITE.test(source))) return false;
  let re: RegExp;
  try {
    re = new RegExp(source, 'i');
  } catch {
    return false;
  }
  return PROBES.filter((probe) => re.test(probe)).length < 2;
}

type Rule = { kind: keyof BlockRuleSet; value: string };

const patternRule = (source: string, written = false): Rule | undefined => (usableRegex(source, written) ? { kind: 'patterns', value: source } : undefined);

function regexRule(line: string): Rule | undefined {
  const match = /^\/(.+)\/[a-z]*$/.exec(line.replace(/\s+#.*$/, ''));
  return match ? patternRule(match[1], true) : undefined;
}

function siteRule(host: string, path: string): Rule | undefined {
  const clean = hostOrPattern(host.toLowerCase().replace(/^\*?\./, ''));
  if (!clean) return undefined;
  if (!clean.includes('*') && (!path || path === '/')) return { kind: 'sites', value: clean };
  return patternRule(`^https?://${hostSource(clean, true)}${path && path !== '/' ? abpSource(path) : HOST_END}`);
}

function optionsAllowed(options: string): boolean {
  const tokens = options.match(/(?:[^,"]|"[^"]*")+/g) ?? [];
  return tokens.every((token) => PAGE_OPTIONS.has(token.split('=')[0].trim().toLowerCase()));
}

/** `||example.com^`, `||example.com/path`, `|https://example.com/page`, with options. */
function abpRule(line: string): Rule | undefined {
  const dollar = line.indexOf('$');
  if (dollar >= 0 && !optionsAllowed(line.slice(dollar + 1))) return undefined;
  const pattern = dollar < 0 ? line : line.slice(0, dollar);
  if (!pattern.startsWith('||')) return patternRule(`^${abpSource(pattern.slice(1))}`, true);
  const match = /^([a-z0-9*._-]+)(.*)$/i.exec(pattern.slice(2));
  if (!match) return undefined;
  const [, host, rest] = match;
  const clean = hostOrPattern(host.toLowerCase().replace(/^\*\./, ''));
  if (!clean) return undefined;
  if (!clean.includes('*') && /^(?:[\^/]\*?|\*)?$/.test(rest)) return { kind: 'sites', value: clean };
  return patternRule(`^https?://${hostSource(clean, true)}${/^(?:[\^/]\*?|\*)?$/.test(rest) ? HOST_END : abpSource(rest)}`);
}

/** `*://*.example.com/*`, `https://example.com/blog/*`: a whole address, `*` standing for anything. */
function matchPatternRule(line: string): Rule | undefined {
  const match = /^(\*|https?):\/\/([^/]+)(\/.*)?$/i.exec(line);
  if (!match) return undefined;
  const scheme = match[1] === '*' ? 'https?' : match[1].toLowerCase();
  const path = match[3] ?? '';
  let host = match[2].toLowerCase();
  const subdomains = host.startsWith('*.');
  if (subdomains) host = host.slice(2);
  const clean = hostOrPattern(host);
  if (!clean) return undefined;
  const wholeSite = path === '' || path === '/*';
  if (scheme === 'https?' && wholeSite && !clean.includes('*')) return { kind: subdomains ? 'sites' : 'hosts', value: clean };
  const tail = wholeSite ? HOST_END : `${path.split('*').map(escapeRe).join('.*')}$`;
  return patternRule(`^${scheme}://${hostSource(clean, subdomains)}${tail}`);
}

function bareRule(line: string): Rule | undefined {
  const match = /^([^\s/]+)(\/\S*)?$/.exec(line.replace(/\s+#.*$/, ''));
  return match ? siteRule(match[1], match[2] ?? '') : undefined;
}

type Parsed = ({ allow: boolean } & Rule) | 'cosmetic' | 'unsupported' | 'none';

function parseLine(raw: string): Parsed {
  let line = raw.trim();
  if (!line) return 'none';
  if (line.length > MAX_LINE) return 'unsupported';
  // `##.ad`, `example.com#@#.ad`: hides an element of a page, which a search result isn't.
  if (/^#[@?$%]?#/.test(line)) return 'cosmetic';
  if (/^[#!\[]/.test(line)) return 'none';
  const allow = line.startsWith('@');
  if (allow) line = line.replace(/^@@?/, '').trim();
  const found = (rule: Rule | undefined): Parsed => (rule ? { allow, ...rule } : 'unsupported');
  if (line.startsWith('/')) return found(regexRule(line));
  if (/#[@?$%]?#/.test(line)) return 'cosmetic';
  if (line.startsWith('|')) return found(abpRule(line));
  const hosts = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+(\S+)/.exec(line);
  if (hosts) return found(siteRule(hosts[1], ''));
  if (line.includes('://')) return found(matchPatternRule(line));
  return found(bareRule(line));
}

export interface ParsedBlocklist {
  rules: BlockRules;
  stats: {
    /** Distinct rules kept (blocking and exceptions). */
    rules: number;
    /** Page-element filters (`##…`): not applicable to search results, and not a problem. */
    cosmetic: number;
    /** Lines that look like rules but can't be used (resource-type options, bad syntax, a regex that is unsafe or too broad). */
    unsupported: number;
    /** The first few unusable lines, for telling the user what was left out. */
    examples: string[];
  };
}

const MAX_EXAMPLES = 3;

export function emptyRules(): BlockRules {
  return { block: { sites: [], hosts: [], patterns: [] }, allow: { sites: [], hosts: [], patterns: [] } };
}

export function parseBlocklist(text: string): ParsedBlocklist {
  const sets = {
    block: { sites: new Set<string>(), hosts: new Set<string>(), patterns: new Set<string>() },
    allow: { sites: new Set<string>(), hosts: new Set<string>(), patterns: new Set<string>() },
  };
  const stats: ParsedBlocklist['stats'] = { rules: 0, cosmetic: 0, unsupported: 0, examples: [] };
  const lines = text.split(/\r?\n/);
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  // A uBlacklist subscription may open with a `---` block of name, description and homepage.
  if (lines[start]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > start && line.trim() === '---');
    if (end > start) start = end + 1;
  }
  for (let i = start; i < lines.length; i++) {
    const parsed = parseLine(lines[i]);
    if (parsed === 'none') continue;
    if (parsed === 'cosmetic') stats.cosmetic++;
    else if (parsed === 'unsupported') {
      stats.unsupported++;
      if (stats.examples.length < MAX_EXAMPLES) stats.examples.push(lines[i].trim().slice(0, 80));
    } else sets[parsed.allow ? 'allow' : 'block'][parsed.kind].add(parsed.value);
  }
  const listed = (set: Record<keyof BlockRuleSet, Set<string>>): BlockRuleSet => ({ sites: [...set.sites], hosts: [...set.hosts], patterns: [...set.patterns] });
  const rules: BlockRules = { block: listed(sets.block), allow: listed(sets.allow) };
  stats.rules = [rules.block, rules.allow].reduce((sum, set) => sum + set.sites.length + set.hosts.length + set.patterns.length, 0);
  return { rules, stats };
}

/** One list at a time is parsed again and again (the user's own rules, once per search); keep the last answer. */
let lastParsed: { text: string; parsed: ParsedBlocklist } | undefined;

export function parseBlocklistCached(text: string): ParsedBlocklist {
  if (lastParsed?.text !== text) lastParsed = { text, parsed: parseBlocklist(text) };
  return lastParsed.parsed;
}

// ---------------------------------------------------------------------------------------------------------------------
// Matching

/** Rules of one kind-set, ready to ask. Building one is the costly part, so it is kept for as long as the rules object lives. */
class RuleIndex {
  private readonly sites: Set<string>;
  private readonly hosts: Set<string>;
  private readonly patterns: RegExp[] = [];
  readonly size: number;

  constructor(set: BlockRuleSet) {
    this.sites = new Set(set.sites);
    this.hosts = new Set(set.hosts);
    for (const source of set.patterns) {
      try {
        this.patterns.push(new RegExp(source, 'i'));
      } catch {
        // A stored list from another version; leave the rule out.
      }
    }
    this.size = this.sites.size + this.hosts.size + this.patterns.length;
  }

  has(host: string, url: string): boolean {
    if (this.hosts.has(host)) return true;
    // `a.b.example.com` is under `b.example.com`, `example.com`, `com`.
    for (let name = host; ; ) {
      if (this.sites.has(name)) return true;
      const dot = name.indexOf('.');
      if (dot < 0) break;
      name = name.slice(dot + 1);
    }
    const target = url.length > 2048 ? url.slice(0, 2048) : url;
    return this.patterns.some((pattern) => pattern.test(target));
  }
}

const indexes = new WeakMap<BlockRuleSet, RuleIndex>();

function indexOf(set: BlockRuleSet): RuleIndex {
  let index = indexes.get(set);
  if (!index) indexes.set(set, (index = new RuleIndex(set)));
  return index;
}

export interface Blocklist {
  /** The name of the list that hides this address, or undefined. An exception in any list wins over a block in any list. */
  match(url: string, host: string): string | undefined;
}

const MAX_MEMO = 4000;

/** Undefined when there is nothing to block with. */
export function compileBlocklist(lists: NamedBlockRules[]): Blocklist | undefined {
  const blocking = lists.map((list) => ({ name: list.name, index: indexOf(list.rules.block) })).filter((list) => list.index.size);
  if (!blocking.length) return undefined;
  const allowing = lists.map((list) => indexOf(list.rules.allow)).filter((index) => index.size);
  const memo = new Map<string, string | null>();
  return {
    match(url, rawHost) {
      const key = `${rawHost}\n${url}`;
      const known = memo.get(key);
      if (known !== undefined) return known ?? undefined;
      const host = rawHost.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
      let found: string | null = null;
      if (!allowing.some((index) => index.has(host, url))) found = blocking.find((list) => list.index.has(host, url))?.name ?? null;
      if (memo.size >= MAX_MEMO) memo.clear();
      memo.set(key, found);
      return found ?? undefined;
    },
  };
}

/** The user's own rules plus the subscribed lists the caller has kept. Never throws: a list that can't be read is left out. */
export async function loadBlocklist(config: FusionConfig, env: Env): Promise<Blocklist | undefined> {
  const { blocklists } = config.judge;
  const lists: NamedBlockRules[] = [];
  try {
    if (env.loadBlocklists) lists.push(...(await env.loadBlocklists(blocklists)));
  } catch {
    // Subscribed lists are an extra; the search goes on without them.
  }
  if (blocklists.custom.trim()) lists.push({ id: 'custom', name: '自定义规则', rules: parseBlocklistCached(blocklists.custom).rules });
  return compileBlocklist(lists);
}
