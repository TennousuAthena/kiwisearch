import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { markdownSnippet } from '../src/text';

interface ExaResult {
  title: string;
  url: string;
  highlights?: string[];
  text: string;
}
const exa = JSON.parse(readFileSync(new URL('./fixtures/exa.json', import.meta.url), 'utf8')).results as ExaResult[];
const page = (needle: string) => {
  const found = exa.find((r) => r.url.includes(needle));
  if (!found) throw new Error(`no fixture result for ${needle}`);
  return found;
};
const snippetOf = (r: ExaResult) => markdownSnippet([r.highlights?.[0], r.text], { title: r.title, max: 300 });

describe('markdownSnippet on real Exa answers', () => {
  it('skips the Wikipedia infobox and starts with the first paragraph after it (the snippet that showed `| --- | --- |`)', () => {
    const wiki = page('zh.wikipedia.org');
    // The raw answer is a table first, as it was when it reached the page.
    expect(wiki.highlights?.[0]).toMatch(/\| --- \| --- \|/);
    const snippet = snippetOf(wiki);
    expect(snippet).toMatch(/^浙江稠州商业银行是一家总部位于中国浙江省义乌市的商业银行。稠州是唐朝时期义乌曾用过的历史名称。/);
    expect(snippet).not.toContain('|');
    expect(snippet.length).toBeLessThanOrEqual(300);
  });

  it('leaves no table, heading mark, footnote mark or link syntax in any of the twelve results, and none is empty', () => {
    for (const r of exa) {
      const snippet = snippetOf(r);
      expect(snippet.length, r.url).toBeGreaterThan(30);
      expect(snippet.length, r.url).toBeLessThanOrEqual(300);
      expect(snippet, r.url).not.toMatch(/\||-{3,}|(^|\s)#{1,6}\s|\[\d+\]|\]\(|\*\*|!\[/);
    }
  });

  it('reads the Baidu Baike result as prose, without its heading or footnote marks', () => {
    const snippet = snippetOf(page('baike.baidu.com'));
    expect(snippet).toMatch(/^浙江稠州商业银行是一家具有独立法人资格的城市商业银行，成立于1987年6月，前身为义乌市稠州城市信用社。/);
  });

  it('reads a page that is a list (announcements) as its items, not as the address in its footer', () => {
    const snippet = snippetOf(page('czcb.com.cn/czcb/gywm/yxgg'));
    expect(snippet).toMatch(/^关于我行系统切换演练的公告 2026-08-10 · /);
    expect(snippet).not.toContain('地址');
  });

  it('reads a ranking table of five columns as the table, and not the copyright line after it', () => {
    const snippet = snippetOf(page('gotohui.com/ranking/gdp/province/2025'));
    expect(snippet).toMatch(/^排名 地区 GDP（亿元） 同比 详情；1 广东 145846\.80 \+3\.08% 详情；2 江苏/);
    expect(snippet).not.toContain('邮箱');
  });

  it('does not take a `### 来源 | … | …` byline for a table, and starts with the article', () => {
    expect(snippetOf(page('mycaijing.com'))).toMatch(/^近日，31省份2025年经济“成绩单”全部出炉。/);
  });
});

describe('markdownSnippet', () => {
  const table = (rows: string[][]) => rows.map((r) => `| ${r.join(' | ')} |`).join('\n');

  it('skips a two-column infobox for the prose after it', () => {
    const md = `Title\n\n${table([['Name', ''], ['---', '---'], ['Founded', '1987'], ['Seat', 'Yiwu']])}\n\nThe bank was founded in 1987 and has its seat in Yiwu, in Zhejiang province.`;
    expect(markdownSnippet([md])).toBe('The bank was founded in 1987 and has its seat in Yiwu, in Zhejiang province.');
  });

  it('reads a table of three or more columns that comes before any prose', () => {
    const md = `# Ranking\n\n${table([['Rank', 'Province', 'GDP'], ['---', '---', '---'], ['1', 'Guangdong', '14.58'], ['2', 'Jiangsu', '14.23']])}\n\nSource: the statistics bureau, which publishes these figures every year.`;
    expect(markdownSnippet([md])).toBe('Rank Province GDP；1 Guangdong 14.58；2 Jiangsu 14.23');
  });

  it('reads an infobox alone as "label：value" pairs when nothing else is there', () => {
    const md = table([['Name', ''], ['---', '---'], ['Founded', '1987'], ['', '322001'], ['Seat', 'Yiwu']]);
    expect(markdownSnippet([md])).toBe('Founded：1987；Seat：Yiwu');
  });

  it('takes the first content block in page order: a footer is never preferred to what comes before it', () => {
    const items = '- Notice of the system switch drill 2026-08-10\n- Notice of the card network upgrade 2026-11-10\n- Loan contract disclosure 2026-11-06';
    const md = `Notices\n\n${items}\n\nAddress: 188 Shangcheng Avenue, Futian Street, Yiwu City, Zhejiang. Postcode 322000.`;
    expect(markdownSnippet([md])).toBe('Notice of the system switch drill 2026-08-10 · Notice of the card network upgrade 2026-11-10 · Loan contract disclosure 2026-11-06');
  });

  it('does not take a menu for content', () => {
    const md = '- Home\n- About us\n- Contact\n- News\n\nThe bank has served small businesses in Yiwu since 1987 and keeps growing.';
    expect(markdownSnippet([md])).toBe('The bank has served small businesses in Yiwu since 1987 and keeps growing.');
  });

  it('takes the list that follows a sentence ending in a colon', () => {
    const md = 'There are only three rules you really need to memorize:\n\n1. Each value has an owner of its own.\n2. There can only be one owner at a time.\n3. When the owner goes out of scope, the value is dropped.';
    expect(markdownSnippet([md])).toBe(
      'There are only three rules you really need to memorize: Each value has an owner of its own. · There can only be one owner at a time. · When the owner goes out of scope, the value is dropped.',
    );
  });

  it('strips links, images, footnote marks, emphasis, code ticks, tags and zero-width marks, and closes the gap a footnote mark left', () => {
    const md = 'The **bank** is [listed](https://example.com/x) as a _city_ bank [9] , founded in `1987`.​ ![logo](https://example.com/l.png) <b>Seat</b>: Yiwu <https://example.com> end.';
    expect(markdownSnippet([md])).toBe('The bank is listed as a city bank, founded in 1987. Seat: Yiwu end.');
  });

  it('joins a line wrapped inside a sentence without a space between two CJK characters, and with one between words', () => {
    expect(markdownSnippet(['本公司董事会、监事会及\n董事、监事、高级管理人员保证本报告内容的真实、准确、完整。'])).toBe('本公司董事会、监事会及董事、监事、高级管理人员保证本报告内容的真实、准确、完整。');
    expect(markdownSnippet(['Ownership is a set of rules that govern how a Rust\nprogram manages memory while it runs.'])).toBe('Ownership is a set of rules that govern how a Rust program manages memory while it runs.');
  });

  it('leaves out the page title repeated at the top, headings, a header or footer with a pipe in it, code and a bare `...` or `-`', () => {
    const md = 'Rust Ownership: a guide to what it means for the memory of a program | Docs\n\n# Rust Ownership: a guide\n\n-\n...\n\n```rust\nlet s = String::from("hi");\n\nlet t = s;\n```\n\nOwnership is what lets Rust manage memory with no garbage collector at all.';
    expect(markdownSnippet([md], { title: 'Rust Ownership: a guide' })).toBe('Ownership is what lets Rust manage memory with no garbage collector at all.');
  });

  it('adds the next paragraphs until there is enough, and stops at a sentence end when it has to cut', () => {
    const sentence = 'This sentence is about thirty-five chars. ';
    const long = `${sentence.repeat(5).trim()}\n\n${sentence.repeat(8).trim()}`;
    const snippet = markdownSnippet([long], { max: 300 });
    expect(snippet.length).toBeLessThanOrEqual(300);
    expect(snippet.endsWith('chars.')).toBe(true);
    // One long paragraph with no sentence end near the limit is cut at the limit.
    expect(markdownSnippet(['word '.repeat(200)], { max: 100 })).toMatch(/…$/);
  });

  it('uses the next source when the first has nothing to read, and gives an empty string for nothing at all', () => {
    expect(markdownSnippet([table([['a', 'b'], ['---', '---']]), 'A paragraph that is long enough to be taken as the description of the page.'])).toBe(
      'A paragraph that is long enough to be taken as the description of the page.',
    );
    expect(markdownSnippet([undefined, ''])).toBe('');
    expect(markdownSnippet([])).toBe('');
  });

  it('keeps short plain text, such as a highlight of one short sentence, when there is no prose to prefer', () => {
    expect(markdownSnippet(['A useful highlight'])).toBe('A useful highlight');
  });

  it('is not slowed down by a very large page', () => {
    const started = performance.now();
    markdownSnippet(['| a | b | c |\n| --- | --- | --- |\n'.repeat(20_000)]);
    markdownSnippet(['word '.repeat(400_000)]);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
