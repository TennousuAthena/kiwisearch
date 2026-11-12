import type { BrowserEngine } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

/**
 * Brave Search's own results page, read in the user's browser like Google's: the keyless counterpart of the `brave` API source
 * (`sources/brave.ts`, which needs a key). The links on the page are direct, so nothing needs resolving. The page carries about
 * twenty results; an AI answer, an FAQ and a news/video `cluster` sit among them with other `data-type`s and are not results.
 *
 * Brave's bot check shows a slider captcha at the *same* address as the results (a cold headless profile got it, the user's own
 * browser did not), so `isBlockedUrl` has nothing to go on and `blockedSelector` carries it.
 */
export const bravesearch: BrowserEngine = {
  id: 'bravesearch',
  label: 'Brave Search',
  modes: ['web'],
  buildUrl: (query) => `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
  matches: ['*://search.brave.com/search*'],
  readySelector: '.snippet[data-type="web"]',
  blockedSelector: '.captcha-wrapper, canvas.captcha-image-canvas',
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const item of doc.querySelectorAll('.snippet[data-type="web"]')) {
      const heading = item.querySelector('.search-snippet-title') ?? item.querySelector('.title');
      const url = absoluteHttpUrl(heading?.closest('a')?.getAttribute('href'), pageUrl);
      const title = cleanText(heading);
      if (!url || !title || seen.has(url) || new URL(url).hostname === 'search.brave.com') continue;
      seen.add(url);
      // A date is already part of the text ("31 March 2025 - …"). A Reddit-style result has a question and answer card, not a snippet.
      const snippet = cleanText(item.querySelector('.generic-snippet .content') ?? item.querySelector('.inline-qa-question'));
      hits.push({ url, title, snippet, rank: hits.length + 1 });
    }
    return hits;
  },
};
