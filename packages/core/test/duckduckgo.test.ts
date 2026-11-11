import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { duckduckgo } from '../src/engines/duckduckgo';

const dom = (html: string) => {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as ParentNode;
};
const PAGE = 'https://duckduckgo.com/?q=quic&ia=web';

/** The structure seen on a real results page (class names left out): the snippet sits in div[data-result="snippet"]. */
const article = (url: string, title: string, snippetMarkup: string) =>
  `<article data-testid="result"><div><div><a data-testid="result-extras-url-link" href="${url}"><span><p><span>${url}</span></p></span></a></div></div>
    <div><h2><a data-testid="result-title-a" href="${url}"><span>${title}</span></a></h2></div>${snippetMarkup}</article>`;

describe('DuckDuckGo engine snippets', () => {
  it('reads a snippet for every result of the real captured page (it used to read none, and nothing checked)', () => {
    const hits = duckduckgo.extract(dom(readFileSync(new URL('./fixtures/duckduckgo.html', import.meta.url), 'utf8')), PAGE, 'web');
    expect(hits).toHaveLength(10);
    for (const hit of hits) expect(hit.snippet.length, hit.url).toBeGreaterThan(40);
    // A date sits in a span of its own in front of the text; it must not run into the first word.
    for (const hit of hits) expect(hit.snippet, hit.url).not.toMatch(/\d{4}[A-Za-z]/);
    expect(hits[0].snippet).toMatch(/^Jun 8, 2026 — Reciprocal Rank Fusion \(RRF\) is an algorithm/);
  });

  it('reads the snippet from the current markup, and from the older markers', () => {
    const hits = duckduckgo.extract(
      dom(
        article('https://en.wikipedia.org/wiki/QUIC', 'QUIC - Wikipedia', '<div><div data-result="snippet"><div><span><span>QUIC is a general-purpose transport layer network protocol.</span></span></div></div></div>') +
          article('https://example.com/dated', 'Dated', '<div><div data-result="snippet"><div><span><span>23 Jul 2025</span><span><b>QUIC</b> is a protocol.</span></span></div></div></div>') +
          article('https://example.com/old-testid', 'Old test id', '<div data-testid="result-snippet">Snippet under the older test id.</div>') +
          article('https://example.com/old-class', 'Old class', '<div class="result__snippet">Snippet under the older class.</div>') +
          article('https://example.com/none', 'No snippet', ''),
      ),
      PAGE,
      'web',
    );
    expect(hits.map((hit) => hit.snippet)).toEqual([
      'QUIC is a general-purpose transport layer network protocol.',
      '23 Jul 2025 — QUIC is a protocol.',
      'Snippet under the older test id.',
      'Snippet under the older class.',
      '',
    ]);
    expect(hits.map((hit) => hit.url)).toEqual(['https://en.wikipedia.org/wiki/QUIC', 'https://example.com/dated', 'https://example.com/old-testid', 'https://example.com/old-class', 'https://example.com/none']);
    expect(hits[0].title).toBe('QUIC - Wikipedia');
  });
});
