import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { bravesearch } from '../src/engines/bravesearch';

const dom = (html: string) => {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as ParentNode;
};
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const PAGE = 'https://search.brave.com/search?q=rust+ownership&source=web';

/** The structure seen on the real page (class names left out where nothing reads them). */
const result = (href: string, title: string, body: string) =>
  `<div class="snippet" data-pos="0" data-type="web"><div class="result-body"><div class="result-content"><a href="${href}" class="l1"><div class="title search-snippet-title">${title}</div></a>${body}</div></div></div>`;
const generic = (text: string) => `<div class="generic-snippet"><div class="content">${text}</div></div>`;

describe('Brave Search engine', () => {
  it('reads every web result of the real page, in order, and nothing else on it', () => {
    const html = fixture('bravesearch.html');
    const page = dom(html);
    const hits = bravesearch.extract(page, PAGE, 'web');
    // The page also carries an AI answer, an FAQ and a news/video cluster; only data-type="web" blocks are results.
    expect(page.querySelectorAll('.snippet[data-type="web"]')).toHaveLength(20);
    expect(hits).toHaveLength(20);
    expect(hits.map((hit) => hit.rank)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(20);
    for (const hit of hits) {
      expect(hit.url, hit.title).toMatch(/^https:\/\//);
      expect(new URL(hit.url).hostname, hit.title).not.toBe('search.brave.com');
      expect(hit.title.length, hit.url).toBeGreaterThan(3);
      expect(hit.snippet.length, hit.url).toBeGreaterThan(40);
    }
    expect(hits[0]).toMatchObject({
      url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html',
      title: 'What is Ownership? - The Rust Programming Language',
    });
    expect(hits[0].snippet).toMatch(/^Ownership is a set of rules that govern how a Rust program manages memory\./);
  });

  it('keeps the date Brave puts in front of a snippet, and does not read a thumbnail link as a second result', () => {
    const hits = bravesearch.extract(dom(fixture('bravesearch.html')), PAGE, 'web');
    // Results with a thumbnail have two more anchors to the same address.
    const withThumbnail = hits.find((hit) => hit.url === 'https://www.w3schools.com/rust/rust_ownership.php');
    expect(withThumbnail?.title).toBe('Rust Ownership');
    expect(hits.filter((hit) => hit.url.includes('w3schools.com/rust/rust_ownership'))).toHaveLength(1);
    expect(hits.find((hit) => hit.url.startsWith('https://educatedguesswork.org/posts/memory-management-4'))?.snippet).toMatch(/^31 March 2025 - The answer to that question/);
  });

  it('uses the question of a Reddit-style result when it has no ordinary snippet', () => {
    const hits = bravesearch.extract(dom(fixture('bravesearch.html')), PAGE, 'web');
    const reddit = hits.find((hit) => hit.url.startsWith('https://www.reddit.com/r/rust/comments/w060ly/'));
    expect(reddit?.title).toMatch(/^r\/rust on Reddit: Rust ownership/);
    expect(reddit?.snippet).toMatch(/^16 July 2022 - Rust ownership is poorly simplified/);
  });

  it('skips a result with no link or title, a link back into Brave Search, and a repeated address', () => {
    const hits = bravesearch.extract(
      dom(
        result('https://example.com/a', 'First', generic('first snippet')) +
          result('https://example.com/a', 'First again', generic('same address')) +
          result('/search?q=related', 'Related search', generic('inside brave')) +
          result('https://search.brave.com/search?q=x', 'Absolute inside brave', generic('inside brave')) +
          result('javascript:void(0)', 'Not a page', generic('x')) +
          result('https://example.com/b', '', generic('no title')) +
          `<div class="snippet" data-type="web"><div class="result-content">no link at all</div></div>` +
          `<div class="snippet" data-type="ad">${generic('an ad')}<a href="https://ads.example.com/">Ad</a></div>` +
          result('https://example.com/c', 'Third', ''),
      ),
      PAGE,
      'web',
    );
    expect(hits.map((hit) => [hit.rank, hit.url, hit.title, hit.snippet])).toEqual([
      [1, 'https://example.com/a', 'First', 'first snippet'],
      [2, 'https://example.com/c', 'Third', ''],
    ]);
  });

  it('builds the search address, escaping the query', () => {
    expect(bravesearch.buildUrl('rust ownership', 10, 'web')).toBe('https://search.brave.com/search?q=rust%20ownership&source=web');
    expect(bravesearch.buildUrl('a&b=c d', 10, 'web')).toBe('https://search.brave.com/search?q=a%26b%3Dc%20d&source=web');
  });
});

describe('Brave Search block page', () => {
  // The captcha comes at the same address as the results (checked in a cold headless Chromium), so only the page itself can tell.
  it('is recognized on the real captcha page, which has no result to read', () => {
    const page = dom(fixture('bravesearch-blocked.html'));
    expect(page.querySelector(bravesearch.blockedSelector)).toBeTruthy();
    expect(page.querySelector(bravesearch.readySelector)).toBeNull();
    expect(bravesearch.extract(page, PAGE, 'web')).toEqual([]);
  });

  it('is not mistaken for the real results page, which is ready', () => {
    const page = dom(fixture('bravesearch.html'));
    expect(page.querySelector(bravesearch.blockedSelector)).toBeNull();
    expect(page.querySelector(bravesearch.readySelector)).toBeTruthy();
  });

  it('is read by the content script on search pages only', () => {
    expect(bravesearch.matches).toEqual(['*://search.brave.com/search*']);
  });
});
