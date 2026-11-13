import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig, usableSources } from '../src/config';
import { BROWSER_ENGINES } from '../src/engines';
import { SOURCES } from '../src/sources';
import { kagi } from '../src/engines/kagi';

const PAGE = 'https://kagi.com/search?q=typescript+handbook';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// kagi.html: the rendered DOM of a real results page, read in a browser with no Kagi session (see its first line). kagi-signed-in.html: the same
// kind of page read in a browser signed in to a trial account, trimmed. kagi-blocked.html: the real Turnstile page the signed-out browser was
// sent to first. kagi-edge-cases.html is hand-written (its first line says so) and covers what the real pages do not happen to contain:
// duplicates, internal and unsafe links, the news and Wikipedia modules, a missing title.
const real = fixture('kagi.html');
const signedIn = fixture('kagi-signed-in.html');
const turnstile = fixture('kagi-blocked.html');
const edgeCases = fixture('kagi-edge-cases.html');
function dom(html: string): ParentNode {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as ParentNode;
}

describe('Kagi web search (real result page, signed out, captured 2026-11-13)', () => {
  const hits = kagi.extract(dom(real), PAGE, 'web');

  it('reads the ten main results in page order, then the four grouped ones', () => {
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://www.typescriptlang.org/docs/handbook/intro.html',
      'https://typescriptdocs.com/handbook/the-handbook.html',
      'https://devblogs.microsoft.com/typescript/announcing-the-new-typescript-handbook/',
      'https://typescript-v2-801.vercel.app/docs/handbook/intro.html',
      'https://typescripthandbook.github.io/',
      'https://github.com/Microsoft/TypeScript-Handbook',
      'https://larsfosdal.blog/2021/04/14/typescript-handbook-rewrite/',
      'https://freecomputerbooks.com/The-TypeScript-Handbook.html',
      'https://flaviocopes.com/the-typescript-handbook-2025-edition/',
      'https://typescript.fm/10',
      // The four pages of typescriptlang.org that Kagi groups under its first result.
      'https://www.typescriptlang.org/docs/handbook/typescript-from-scratch.html',
      'https://www.typescriptlang.org/tsconfig/',
      'https://www.typescriptlang.org/docs/handbook/2/modules.html',
      'https://www.typescriptlang.org/docs/handbook/2/basic-types.html',
    ]);
    expect(hits.map((hit) => hit.rank)).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(14);
  });

  it('takes titles as text, for main and grouped results alike', () => {
    expect(hits[0].title).toBe('TypeScript: Handbook - The TypeScript Handbook');
    expect(hits[5].title).toMatch(/^GitHub - microsoft\/TypeScript-Handbook/);
    expect(hits.slice(10).map((hit) => hit.title)).toEqual(['TypeScript', 'TSConfig Reference', 'Modules', 'The Basics']);
  });

  it('leaves the date badge Kagi puts at the start of a description out of the snippet', () => {
    const page = dom(real);
    expect(page.querySelectorAll('.__sri-time')).toHaveLength(8);
    expect(hits[0].snippet).toBe('The TypeScript Handbook is intended to be a comprehensive document that explains TypeScript to everyday programmers.');
    expect(hits[2].snippet).toMatch(/^Hey folks, we/);
    for (const hit of hits) expect(hit.snippet).not.toMatch(/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}/);
    // Extraction works on a copy: the date is still on the page afterwards, where the content script reads it again.
    kagi.extract(page, PAGE, 'web');
    expect(page.querySelectorAll('.__sri-time')).toHaveLength(8);
  });

  it('cuts a long description at 300 characters and keeps a short one whole', () => {
    expect(hits.filter((hit) => hit.snippet.length === 300).map((hit) => hit.rank)).toEqual([5, 11, 14]);
    expect(hits[4].snippet.endsWith('…')).toBe(true);
    expect(hits.every((hit) => hit.snippet.length > 0 && hit.snippet.length <= 300)).toBe(true);
  });

  it('builds the search route and recognizes the page as results: neither a verification nor a login', () => {
    const url = new URL(kagi.buildUrl('中文 & TypeScript?', 10, 'web'));
    expect(url.origin + url.pathname).toBe('https://kagi.com/search');
    expect(url.searchParams.get('q')).toBe('中文 & TypeScript?');
    expect(kagi.modes).toEqual(['web']);
    expect(dom(real).querySelector(kagi.readySelector)).not.toBeNull();
    expect(dom(real).querySelector(kagi.blockedSelector)).toBeNull();
    expect(kagi.isBlockedUrl?.(PAGE)).toBe(false);
    expect(kagi.isLoginUrl?.(PAGE)).toBe(false);
    // The "Log In" / "Sign Up" bar and the "Create Account" button of a signed-out page are part of a page that does hold results.
    expect(dom(real).querySelector('.auth-bar-links a[href="/signin"]')).not.toBeNull();
  });
});

describe('Kagi web search (real result page, signed in to a trial account, captured 2026-11-13)', () => {
  const page = dom(signedIn);
  const hits = kagi.extract(page, 'https://kagi.com/search?q=typescript+handbook', 'web');

  it('reads the eleven main results in page order, then the six grouped ones', () => {
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://www.typescriptlang.org/docs/handbook/intro.html',
      'https://www.tslang.com.cn/zh/docs/handbook/intro.html',
      'https://www.freecodecamp.org/news/learn-typescript-with-react-handbook/',
      'https://typescriptdocs.com/handbook/the-handbook.html',
      'https://typescript.net.cn/docs/handbook/intro.html',
      'https://gitee.com/user_a/TypeScript-Handbook-zh/blob/master/doc/handbook/tutorials/Migrating%20from%20JavaScript.md',
      'https://typescript-handbook.netlify.app/handbook/intro',
      'https://microsoft.github.io/TypeScript-New-Handbook/everything/',
      'https://freecomputerbooks.com/The-TypeScript-Handbook.html',
      'https://typescripthandbook.github.io/',
      'https://www.w3schools.com/typescript/',
      // Grouped under the first, second and fourth main results.
      'https://www.typescriptlang.org/docs/handbook/typescript-from-scratch.html',
      'https://www.typescriptlang.org/tsconfig/',
      'https://www.typescriptlang.org/docs/handbook/2/modules.html',
      'https://www.typescriptlang.org/docs/handbook/2/basic-types.html',
      'https://www.tslang.com.cn/docs/handbook/intro.html',
      'https://typescriptdocs.com/',
    ]);
    expect(hits.map((hit) => hit.rank)).toEqual(Array.from({ length: 17 }, (_, index) => index + 1));
    expect(page.querySelectorAll('.search-result')).toHaveLength(11);
    expect(page.querySelectorAll('.sr-group .__srgi')).toHaveLength(6);
  });

  it('takes the text of a description that carries a Summarize link on every result, and no date where there is none', () => {
    // A signed-in page puts a Summarize link in every description (17 of 17 here), a signed-out one does not. Its label follows the interface
    // language: this page, in en-GB, says "Summarise".
    expect(page.querySelectorAll('.summarize-link')).toHaveLength(17);
    expect(page.querySelector('.summarize-link')?.textContent).toBe('Summarise');
    expect(page.querySelectorAll('.__sri-time').length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.snippet).not.toMatch(/Summari[sz]e/);
      expect(hit.snippet).not.toMatch(/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}/);
    }
    expect(hits[0].snippet).toMatch(/^The TypeScript Handbook is intended to b/);
    expect(hits.filter((hit) => hit.snippet.length === 300).map((hit) => hit.rank)).toEqual([12, 16]);
  });

  it('keeps the link-only result Kagi shows when it has no title or text for a page (a placeholder title, no snippet)', () => {
    expect(hits[5]).toMatchObject({ title: 'Link to gitee.com', snippet: '' });
    expect(new URL(hits[5].url).hostname).toBe('gitee.com');
  });

  it('finds only these elements inside a description: the text, the date, the Summarize link and emphasis', () => {
    const kinds = new Set<string>();
    for (const description of page.querySelectorAll('.__sri-desc')) {
      for (const element of description.querySelectorAll('*')) kinds.add(element.tagName.toLowerCase() + (element.getAttribute('class') ? `.${element.getAttribute('class')!.trim().replace(/\s+/g, '.')}` : ''));
    }
    expect([...kinds].sort()).toEqual(['a._0_summarize_page.summarize-link', 'div', 'span.__sri-time', 'strong']);
  });

  it('is a page with results: neither a verification nor a login, and without the signed-out "Log In" bar', () => {
    expect(page.querySelector(kagi.readySelector)).not.toBeNull();
    expect(page.querySelector(kagi.blockedSelector)).toBeNull();
    expect(page.querySelector('.auth-bar-links')).toBeNull();
    expect(kagi.isBlockedUrl?.('https://kagi.com/search?q=typescript+handbook')).toBe(false);
    expect(kagi.isLoginUrl?.('https://kagi.com/search?q=typescript+handbook')).toBe(false);
  });
});

describe('Kagi web search (hand-written edge cases)', () => {
  const hits = kagi.extract(dom(edgeCases), 'https://kagi.com/search?q=typescript', 'web');

  it('reads main results in page order, then grouped ones, without the other modules', () => {
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://docs.example.org/typescript/',
      'https://developer.example.com/en-US/docs/Glossary/TypeScript',
      'https://forum.example.org/t/typescript-or-javascript/1001',
      'https://blog.example.com/posts/typescript-tips?utm_source=feed',
      'https://github.example.com/example/typescript-starter',
      'https://tutorials.example.net/typescript-course',
      'https://wiki.example.org/TypeScript_(language)',
      'https://forum.example.org/t/typescript-strict-mode/1002',
      'https://forum.example.org/t/typescript-generics/1003',
    ]);
    expect(hits.map((hit) => hit.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // The "More results from …" and "Remove results from …" menu links sit in the title block but are not the title.
    expect(hits[1].title).toBe('TypeScript - Glossary');
    expect(hits[7]).toMatchObject({ title: 'Is strict mode worth turning on?', snippet: 'Strict mode catches more mistakes but makes migrating an old code base slower.' });
  });

  it('takes the snippet as text: markup flattened, script code, date and "Summarize" link dropped, a long one cut, a missing one empty', () => {
    expect(hits[0].snippet).toBe('TypeScript is a strongly typed programming language that builds on JavaScript, giving you better tooling at any scale.');
    expect(hits[1].snippet).toBe('TypeScript is a superset of JavaScript that adds static types and compiles to plain JavaScript.');
    expect(hits[3].snippet).toHaveLength(300);
    expect(hits[3].snippet.endsWith('…')).toBe(true);
    expect(hits[5].snippet).toBe('');
    for (const hit of hits) {
      expect(hit.snippet).not.toMatch(/Summari[sz]e/);
      expect(hit.snippet).not.toMatch(/\b(?:Oct 4, 2026|Yesterday|Mar 3, 2024)\b/);
    }
    // The signed-out page has no "Summarize" link, a signed-in one does; both are handled, and the page itself is left as it was.
    const page = dom(edgeCases);
    kagi.extract(page, PAGE, 'web');
    expect(page.querySelectorAll('.__sri-time')).toHaveLength(3);
    expect(page.querySelectorAll('.summarize-link')).toHaveLength(2);
  });

  it('does not take a block that has only the _0_SRI class (the news module) for a result', () => {
    expect(dom(edgeCases).querySelectorAll('._0_SRI').length).toBeGreaterThan(hits.length);
    expect(hits.some((hit) => hit.url === 'https://news.example.net/typescript-release')).toBe(false);
  });

  it('skips duplicates, internal links, non-http links and results with no title', () => {
    const urls = hits.map((hit) => hit.url);
    expect(urls.filter((url) => url === 'https://docs.example.org/typescript/')).toHaveLength(1);
    expect(hits.find((hit) => hit.title.includes('duplicate'))).toBeUndefined();
    expect(urls.some((url) => new URL(url).hostname === 'kagi.com')).toBe(false);
    expect(urls.some((url) => url.startsWith('javascript:'))).toBe(false);
    expect(urls).not.toContain('https://tutorials.example.net/typescript-in-100-seconds');
    // The news item and the Wikipedia card use other classes.
    expect(urls).not.toContain('https://news.example.net/typescript-release');
    expect(urls.some((url) => url.includes('wikipedia.example'))).toBe(false);
  });
});

describe('Kagi pages that are not results', () => {
  it('treats the Turnstile page as a verification, by address and by its widget (real capture)', () => {
    expect(kagi.isBlockedUrl?.('https://kagi.com/turnstile?r=/search%3Fq%3Dtypescript')).toBe(true);
    expect(kagi.isBlockedUrl?.('https://kagi.com/turnstile')).toBe(true);
    expect(kagi.isBlockedUrl?.('https://kagi.com/turnstiles')).toBe(false);
    expect(dom(turnstile).querySelector(kagi.blockedSelector)).not.toBeNull();
    expect(dom(turnstile).querySelector(kagi.readySelector)).toBeNull();
    expect(kagi.extract(dom(turnstile), 'https://kagi.com/turnstile', 'web')).toEqual([]);
  });

  it('treats the sign-in, which lives on account.kagi.com, as a login wall', () => {
    // Seen when /signin is requested (curl, 2026-11-13). A search in a browser with no session did not go there: it went through Turnstile to results.
    expect(kagi.isLoginUrl?.('https://kagi.com/signin')).toBe(true);
    expect(kagi.isLoginUrl?.('https://account.kagi.com/loginname?requestId=oidc_V2_1')).toBe(true);
    expect(kagi.isLoginUrl?.('https://kagi.com/signing-off')).toBe(false);
    expect(kagi.isLoginUrl?.('https://help.kagi.com/kagi/')).toBe(false);
    for (const pattern of ['*://kagi.com/search*', '*://kagi.com/turnstile*', '*://kagi.com/signin*', '*://account.kagi.com/*']) expect(kagi.matches).toContain(pattern);
  });
});

describe('Kagi as a source', () => {
  it('is registered as a browser engine and is off until the user turns it on', () => {
    expect(BROWSER_ENGINES.kagi).toBe(kagi);
    expect(SOURCES.kagi.requiresBrowser).toBe(true);
    expect(SOURCES.kagi.requiresKey).toBe(false);
    expect(DEFAULT_CONFIG.sources.kagi).toEqual({ enabled: false });
  });

  it('runs in web mode only, and only with the browser extension, once enabled', () => {
    const reason = (config: ReturnType<typeof mergeConfig>, mode: Parameters<typeof usableSources>[2], hasBrowser = true) =>
      usableSources(config, hasBrowser, mode).find((source) => source.id === 'kagi')?.reason;
    expect(reason(DEFAULT_CONFIG, 'web')).toBe('disabled');
    const on = mergeConfig(DEFAULT_CONFIG, { sources: { kagi: { enabled: true } } });
    expect(reason(on, 'web')).toBeUndefined();
    expect(reason(on, 'news')).toBe('not available in news mode');
    expect(reason(on, 'web', false)).toBe('needs browser extension');
  });
});
