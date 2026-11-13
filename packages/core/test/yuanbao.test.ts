import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { yuanbao } from '../src/engines/yuanbao';

const PAGE = 'https://so.qq.com/isearch?query=TypeScript&quick=1';
const fixture = readFileSync(new URL('./fixtures/yuanbao.html', import.meta.url), 'utf8');
function dom(html: string): ParentNode {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as ParentNode;
}

describe('Yuanbao web search (real rendered result cards)', () => {
  const hits = yuanbao.extract(dom(fixture), PAGE, 'web');

  it('reads organic and encyclopedia titles and snippets without related searches or sublinks', () => {
    expect(hits).toHaveLength(14);
    expect(hits.map((hit) => hit.rank)).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
    expect(new Set(hits.map((hit) => hit.url)).size).toBe(14);
    expect(hits[0]).toMatchObject({
      url: 'https://baike.sogou.com/v70611007.htm?ch=frombaikevr&fromTitle=typescript',
      title: 'typescript',
    });
    expect(hits[0].snippet).toMatch(/^typescript是一种由微软开发/);
    expect(hits[1]).toMatchObject({ url: 'https://typescript.net.cn/', title: 'TypeScript 是具有类型语法的 JavaScript。' });
    expect(hits.at(-1)).toMatchObject({ url: 'https://developer.mozilla.org/en-US/docs/Glossary/TypeScript', title: 'TypeScript - Glossary | MDN' });
    expect(hits.some((hit) => new URL(hit.url).hostname === 'mp.weixin.qq.com')).toBe(true);
    for (const hit of hits) {
      expect(hit.snippet.length).toBeGreaterThan(0);
      expect(hit.snippet.length).toBeLessThanOrEqual(300);
      expect(new URL(hit.url).hostname).not.toBe('so.qq.com');
    }
  });

  it('builds the observed ordinary-search route and recognizes the result DOM', () => {
    const url = new URL(yuanbao.buildUrl('中文 & TypeScript?', 10, 'web'));
    expect(url.origin + url.pathname).toBe('https://so.qq.com/isearch');
    expect(url.searchParams.get('query')).toBe('中文 & TypeScript?');
    expect(url.searchParams.get('quick')).toBe('1');
    expect(yuanbao.matches).toContain('*://so.qq.com/isearch*');
    expect(dom(fixture).querySelector(yuanbao.readySelector)).not.toBeNull();
    expect(dom(fixture).querySelector(yuanbao.blockedSelector)).toBeNull();
    expect(yuanbao.modes).toEqual(['web']);
  });

  it('ignores malformed roles, duplicate or internal links and non-HTTP URLs', () => {
    const card = (content: string) => `<article class="result-card">${content}</article>`;
    const title = (url: string, text: string) => `<a href="${url}" data-log='{"linkid":"title"}'>${text}</a>`;
    const found = yuanbao.extract(dom(
      card(`<a data-log='{"linkid":'>Broken role</a>${title('https://example.com/a', 'A <em>title</em>')}<a data-log='{"linkid": "summary"}'>An <b>excerpt</b><script>hidden()</script></a>`) +
      card(title('https://example.com/a', 'Duplicate')) +
      card(title('/isearch?query=related', 'Related')) +
      card(title('javascript:alert(1)', 'Unsafe')) +
      card(title('data:text/html,test', 'Data')) +
      card(title('https://example.com/b', '')) +
      card(`<a href="https://example.com/c" data-log='{"linkid":null}'>Not a title</a>`) +
      card(title('//example.com/d', 'Without a snippet')),
    ), PAGE, 'web');
    expect(found).toEqual([
      { url: 'https://example.com/a', title: 'A title', snippet: 'An excerpt', rank: 1 },
      { url: 'https://example.com/d', title: 'Without a snippet', snippet: '', rank: 2 },
    ]);
  });
});
