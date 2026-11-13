import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

const SNIPPET_MAX = 300;

/**
 * The description's text without the two controls Kagi puts inside it: the result's date (`span.__sri-time`) and the
 * Summarize link (`a.summarize-link`, labelled "Summarise" in an en-GB interface). Left in, a snippet would start with "Oct 4, 2026" and end with "Summarise".
 */
function snippetOf(item: Element): string {
  const description = item.querySelector('.__sri-desc')?.cloneNode(true) as Element | undefined;
  if (!description) return '';
  for (const control of description.querySelectorAll('.__sri-time, .summarize-link')) control.remove();
  return cleanText(description);
}

/**
 * Kagi's own results page, read in the user's browser. Kagi is a paid search engine and a search in a signed-in browser counts against
 * that account's usage; there is no key and no API token involved.
 *
 * Seen on 2026-11-13 in a browser with no Kagi session: `/search` is sent to `/turnstile` (a Cloudflare Turnstile check, `interaction-only`),
 * and once that passes the same address returns a real results page with a "Log In" / "Sign Up" bar, so being signed out is not a login
 * wall. The check passed by itself, 26 to 70 s after the page loaded; until then the page is reported as a captcha, and a second search in
 * the same browser went through at once. The sign-in page (`account.kagi.com`, reached from `/signin`) was not reached by any search; it
 * is treated as a login wall in case one gets there. The selectors were checked against that signed-out page (`test/fixtures/kagi.html`)
 * and against a page read in a signed-in browser (`kagi-signed-in.html`); see docs/internals/sources.md for what that does and does not show.
 */
export const kagi: BrowserEngine = {
  id: 'kagi',
  label: 'Kagi',
  modes: ['web'],
  buildUrl: (query) => `https://kagi.com/search?q=${encodeURIComponent(query)}`,
  matches: ['*://kagi.com/search*', '*://kagi.com/turnstile*', '*://kagi.com/signin*', '*://account.kagi.com/*'],
  // A grouped result (several pages of one site) has no `.__sri_title_link`; its rows link through `.__srgi-title a`.
  readySelector: 'a.__sri_title_link, .__srgi-title a',
  // Kagi's Turnstile page (observed): a `.cf-turnstile` widget at /turnstile?r=<the search>.
  blockedSelector: '.cf-turnstile',
  isBlockedUrl: (url) => {
    const { hostname, pathname } = new URL(url);
    return hostname === 'kagi.com' && /^\/turnstile(?:\/|$)/.test(pathname);
  },
  // Observed: kagi.com/signin redirects to account.kagi.com/loginname. Neither is a page that can hold results.
  isLoginUrl: (url) => {
    const { hostname, pathname } = new URL(url);
    return hostname === 'account.kagi.com' || (hostname === 'kagi.com' && /^\/signin(?:\/|$)/.test(pathname));
  },
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    // Kagi's other blocks (news, videos, Wikipedia, related searches, "interesting finds") use other classes and are not results.
    // A result can come with a `.sr-group` of more pages from the same site (four of them under the first result of the captured page).
    // They are results too, but they come after all the main ones: in page order they would take ranks 2 to 5 and, in the fusion,
    // lift one site's sub-pages above every other engine's results.
    const items = [...doc.querySelectorAll('.search-result'), ...doc.querySelectorAll('.sr-group .__srgi')];
    for (const item of items) {
      const link = item.querySelector('.__sri_title_link, .__srgi-title a');
      const href = link?.getAttribute('href');
      // Result links are direct and absolute; a relative one points back into Kagi (a "search again" or settings link).
      if (!href || !/^https?:\/\//i.test(href)) continue;
      const url = absoluteHttpUrl(href, pageUrl);
      const title = cleanText(link);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      const snippet = snippetOf(item);
      hits.push({ url, title, snippet: snippet.length > SNIPPET_MAX ? `${snippet.slice(0, SNIPPET_MAX - 1)}…` : snippet, rank: hits.length + 1 });
    }
    return hits;
  },
};
