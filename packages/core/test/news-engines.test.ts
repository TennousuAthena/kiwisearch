import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { google } from '../src/engines/google';
import { bravesearch } from '../src/engines/bravesearch';
import { newsThumbnail } from '../src/engines/news';

const NOW = new Date('2026-11-12T18:32:52.099Z');
const GOOGLE = 'https://www.google.com/search?q=artificial+intelligence&tbm=nws';
const BRAVE = 'https://search.brave.com/news?q=artificial+intelligence&source=news';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8');
function dom(html: string): ParentNode {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as ParentNode;
}

describe('Google News search (real rendered fixture)', () => {
  const hits = google.extract(dom(fixture('google-news')), GOOGLE, 'news', NOW);

  it('reads individual stories, including a topic cluster, with publisher and the source timestamp', () => {
    expect(hits).toHaveLength(13);
    expect(hits[0]).toMatchObject({ title: 'Exclusive | United Airlines Is Banning AI Bots From Booking Flights', publishedAt: new Date(1794436980 * 1000).toISOString(), news: { publisher: 'WSJ', timeText: '20 hours ago', timeKind: 'published', retrievedAt: NOW.toISOString() } });
    expect(hits[0].snippet).toMatch(/^The carrier says/);
    expect(hits[0].news?.thumbnail).toMatch(/^data:image\/webp;base64,/);
    expect(hits[4].news?.publisher).toBe('Reuters');
    expect(hits.map((hit) => hit.rank)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(hits.every((hit) => hit.publishedAt && hit.news?.publisher)).toBe(true);
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(13);
    expect(hits.some((hit) => hit.title === 'News about Nvidia')).toBe(false);
  });

  it('keeps Google goto wrappers for the existing resolver and recognizes the new result headings', () => {
    expect(hits[0].url).toMatch(/^https:\/\/www\.google\.com\/goto\?url=/);
    expect(dom(fixture('google-news')).querySelector(google.readySelector)).not.toBeNull();
    expect(dom(fixture('google-news')).querySelector(google.blockedSelector)).toBeNull();
    expect(google.extract(dom(fixture('google-news')), GOOGLE, 'web')).toEqual([]);
  });

  it('uses the live page’s news, date-range and sort query parameters', () => {
    const url = new URL(google.buildUrl('中文 & news', 10, 'news', undefined, { range: 'day', sort: 'date' }));
    expect(url.searchParams.get('q')).toBe('中文 & news');
    expect(url.searchParams.get('tbm')).toBe('nws');
    expect(url.searchParams.get('tbs')).toBe('qdr:d,sbd:1');
    expect(new URL(google.buildUrl('q', 10, 'news', undefined, { range: 'week', sort: 'relevance' })).searchParams.get('tbs')).toBe('qdr:w');
    expect(new URL(google.buildUrl('q', 10, 'news', undefined, { range: 'month', sort: 'relevance' })).searchParams.get('tbs')).toBe('qdr:m');
    expect(new URL(google.buildUrl('q', 10, 'news')).searchParams.has('tbs')).toBe(false);
    expect(google.buildUrl('q', 10, 'web')).toBe('https://www.google.com/search?q=q&num=10');
  });

  it('rejects unsafe or duplicate links and retains missing or ambiguous time labels without inventing dates', () => {
    const card = (url: string, title: string, time = '') => `<a href="${url}"><div class="MgUUmf"><span>Daily</span></div><div role="heading" aria-level="3">${title}</div><div class="UqSP2b">Snippet<script>secret()</script></div>${time}</a>`;
    const found = google.extract(dom(`<div id="search">${card('https://example.com/a', 'A', '<time datetime="2026-11-11">11 Nov</time>')}${card('https://example.com/a', 'Duplicate')}${card('javascript:alert(1)', 'Bad')}${card('/search?q=related', 'Related')}${card('https://example.com/b', 'B', '<span class="LfVVr">today 10:00</span>')}${card('https://example.com/c', 'C')}</div>`), GOOGLE, 'news', NOW);
    expect(found).toHaveLength(3);
    expect(found[0]).toMatchObject({ publishedAt: '2026-11-11', snippet: 'Snippet', news: { timePrecision: 'day', timeText: '11 Nov' } });
    expect(found[1].publishedAt).toBeUndefined();
    expect(found[1].news?.timeText).toBe('today 10:00');
    expect(found[2].publishedAt).toBeUndefined();
  });

  it('does not promote an explicitly updated timestamp to the publication date', () => {
    const found = google.extract(dom('<div id="search"><a href="https://example.com/updated"><div role="heading" aria-level="3">Updated story</div><span data-ts="1794436980">Updated 20 hours ago</span></a></div>'), GOOGLE, 'news', NOW);
    expect(found[0].publishedAt).toBeUndefined();
    expect(found[0].news).toMatchObject({ timeKind: 'updated', updatedAt: new Date(1794436980 * 1000).toISOString(), timeText: 'Updated 20 hours ago' });
  });
});

describe('Brave News search (real rendered fixture)', () => {
  const hits = bravesearch.extract(dom(fixture('bravesearch-news')), BRAVE, 'news', NOW);

  it('reads news title, excerpt, publisher and thumbnail independently of the page-age label', () => {
    expect(hits).toHaveLength(12);
    expect(hits[0]).toMatchObject({ title: 'Artificial Intelligence News -- ScienceDaily', news: { publisher: 'ScienceDaily', timeText: '1 day ago', timeKind: 'unknown', retrievedAt: NOW.toISOString() } });
    expect(hits[0].snippet).not.toContain('1 day ago');
    expect(hits[0].news?.thumbnail).toMatch(/^https:\/\/imgs.search.brave.com\//);
    expect(hits.every((hit) => hit.publishedAt === undefined)).toBe(true);
    expect(hits.map((hit) => hit.rank)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(bravesearch.extract(dom(fixture('bravesearch-news')), BRAVE, 'web')).toEqual([]);
  });

  it('uses the dedicated live news route and content-script match without changing web search', () => {
    expect(bravesearch.buildUrl('中文', 10, 'news')).toBe('https://search.brave.com/news?q=%E4%B8%AD%E6%96%87&source=news');
    expect(bravesearch.matches).toContain('*://search.brave.com/news*');
    expect(dom(fixture('bravesearch-news')).querySelector(bravesearch.readySelector)).not.toBeNull();
    expect(dom(fixture('bravesearch-news')).querySelector(bravesearch.blockedSelector)).toBeNull();
    expect(bravesearch.buildUrl('q', 10, 'web')).toBe('https://search.brave.com/search?q=q&source=web');
  });
});

it('accepts raster thumbnails and HTTPS images, excluding executable image formats and URLs', () => {
  expect(newsThumbnail('data:image/png;base64,aGVsbG8=', GOOGLE)).toBe('data:image/png;base64,aGVsbG8=');
  expect(newsThumbnail('https://example.com/news.webp', GOOGLE)).toBe('https://example.com/news.webp');
  expect(newsThumbnail('data:image/svg+xml;base64,aGVsbG8=', GOOGLE)).toBeUndefined();
  expect(newsThumbnail('javascript:alert(1)', GOOGLE)).toBeUndefined();
});
