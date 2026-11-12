import { parse } from 'node-html-parser';

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** Rough readable-text extraction from an HTML page. */
export function htmlToText(html: string, maxChars = 8000): { title: string; text: string } {
  const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false } });
  const title = root.querySelector('title')?.text.trim() ?? '';
  root
    .querySelectorAll('script,style,noscript,nav,header,footer,aside,form,svg,iframe,[role=navigation]')
    .forEach((n) => n.remove());
  const main =
    root.querySelector('article') ?? root.querySelector('main') ?? root.querySelector('[role=main]') ?? root.querySelector('body') ?? root;
  const blocks = main
    .querySelectorAll('h1,h2,h3,h4,p,li,pre,td,blockquote')
    .map((n) => n.text.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 1);
  let text = blocks.length ? blocks.join('\n') : main.text.replace(/\s+/g, ' ');
  text = decodeEntities(text);
  return { title: decodeEntities(title), text: text.slice(0, maxChars) };
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// ---------------------------------------------------------------------------------------------------------------------
// Markdown → a snippet. Exa returns a page as Markdown (an infobox is a table, a Wikipedia page opens with one), so the start of
// `text` or of a highlight is often `| --- | --- |` rather than something to read.

const CJK = /[⺀-鿿豈-﫿＀-￯]/;
/** Shortest paragraph taken for prose, in width where a CJK character counts double: about 20 CJK characters or 40 Latin ones. */
const MIN_PROSE_WIDTH = 40;
const BULLET = /^([-*+•·]|\d{1,3}[.)])\s+/;
const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const width = (s: string) => s.length + (s.match(new RegExp(CJK.source, 'g'))?.length ?? 0);

/** One line of Markdown as the words a reader sees: links, images, footnote marks, emphasis, code ticks, tags and zero-width marks gone. */
function plainInline(line: string): string {
  return decodeEntities(
    line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/\[(?:\d{1,3}|[a-z]|注\s?\d+)\]/gi, '')
      .replace(/<https?:[^>]*>|<[^>\n]+>|https?:\/\/\S+/g, '')
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1')
      .replace(/(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])/g, '$1')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
      .replace(/[​-‏⁠﻿]/g, ''),
  )
    .replace(/\s+/g, ' ')
    // A footnote mark left a gap before the punctuation that followed it.
    .replace(/\s+([，。；：！？、）】》”,.;:!?)])/g, '$1')
    .replace(/([（【《“(])\s+/g, '$1')
    .trim();
}

type MarkdownBlock = { kind: 'table' | 'list' | 'heading' | 'text'; lines: string[] };

/** Blocks are what the blank lines separate; a bare `-` or `...` line (Exa marks where it cut) and a rule are not content. */
function markdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const noise = /^([-*+•]?\s*(\.{3}|…)?|-{3,}|\*{3,}|_{3,})$/;
  const tableLine = (l: string) => !l.startsWith('#') && (l.startsWith('|') || (l.match(/\|/g)?.length ?? 0) >= 2);
  for (const raw of markdown.replace(/\r\n?/g, '\n').replace(/```[\s\S]*?(```|$)/g, '\n\n').split(/\n[ \t]*\n/)) {
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => !noise.test(l));
    if (!lines.length) continue;
    const share = (test: (l: string) => boolean) => lines.filter(test).length / lines.length;
    const kind = share(tableLine) >= 0.5 ? 'table' : lines.every((l) => /^#{1,6}\s/.test(l)) ? 'heading' : share((l) => BULLET.test(l)) >= 0.5 ? 'list' : 'text';
    blocks.push({ kind, lines: kind === 'text' ? lines.filter((l) => !/^#{1,6}\s/.test(l)) : lines });
  }
  return blocks;
}

/** The cells of each row of a table; the `| --- |` line and empty cells say nothing. */
function tableRows(lines: string[]): string[][] {
  return lines.filter((l) => !/^[\s|:-]+$/.test(l)).map((l) => l.split('|').map(plainInline).filter(Boolean));
}

/** Three or more columns and a header over at least one row: a table of data, which is what its page is about. Two columns are "label | value", an infobox. */
function isDataTable(lines: string[]): boolean {
  const rows = tableRows(lines);
  return rows.length >= 2 && rows.filter((cells) => cells.length >= 3).length * 2 >= rows.length;
}

/** A block's words. Lines wrapped inside a sentence are joined, with no space between two CJK characters. */
function blockText({ kind, lines }: MarkdownBlock): string {
  if (kind === 'table') {
    // A row of an infobox is "label | value": read as "label：value".
    return tableRows(lines)
      .filter((cells) => cells.length >= 2 || (cells.length === 1 && width(cells[0]) >= 12))
      .map((cells) => (cells.length === 2 ? `${cells[0]}：${cells[1]}` : cells.join(' ')))
      .join('；');
  }
  if (kind === 'list') return lines.map((l) => plainInline(l.replace(BULLET, ''))).filter(Boolean).join(' · ');
  let out = '';
  for (const raw of lines) {
    const line = plainInline(kind === 'heading' ? raw.replace(/^#{1,6}\s+/, '') : raw.replace(/^>\s?/, ''));
    if (!line) continue;
    out += out && !(CJK.test(out.slice(-1)) && CJK.test(line[0])) ? ` ${line}` : line;
  }
  return out;
}

/** Cut at the last sentence end in the last 40% of the limit if there is one, else at the limit. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(...['。', '！', '？', '. ', '! ', '? '].map((mark) => cut.lastIndexOf(mark)));
  return end >= max * 0.6 ? cut.slice(0, end + 1) : truncate(text, max);
}

/**
 * Readable text for a result's snippet from Markdown (the first of `sources` that has any), taken from the first block that has
 * something to say, in the order of the page, so a footer never comes before the content. That block is a paragraph of prose (and
 * the paragraphs after it, until there is enough; a paragraph ending in a colon also takes the list that follows), a list whose items
 * are more than menu entries, or a table of three or more columns (a ranking, a rate table), which is read as it is. A two-column table
 * is an infobox ("label | value") and is skipped for what follows it. Headings, code, the page title repeated at the top and a line with
 * a `|` in it (a header, a footer, a breadcrumb) say nothing. A page with none of these falls back to its list, then its table read as
 * "label：value" pairs, then whatever short lines there are.
 */
export function markdownSnippet(sources: (string | undefined)[], opts: { title?: string; max?: number } = {}): string {
  const max = opts.max ?? 300;
  const title = norm(opts.title ?? '');
  type Part = { kind: MarkdownBlock['kind']; text: string; lines: number; data: boolean };
  const pages = sources
    .filter((s): s is string => !!s)
    .map((s): Part[] => markdownBlocks(s).map((block) => ({ kind: block.kind, text: blockText(block), lines: block.lines.length, data: block.kind === 'table' && isDataTable(block.lines) })));
  const readable = (text: string) => !!text && !(title && title.includes(norm(text)));
  const isProse = (b: Part) => b.kind === 'text' && !b.text.includes('|') && width(b.text) >= MIN_PROSE_WIDTH && readable(b.text);
  // A menu is a list of short entries; a list of announcements or results has items of a few words.
  const isContentList = (b: Part) => b.kind === 'list' && width(b.text) >= MIN_PROSE_WIDTH && width(b.text) / b.lines >= 16 && readable(b.text);
  const isContent = (b: Part) => isProse(b) || isContentList(b) || (b.data && readable(b.text));
  for (const blocks of pages) {
    const first = blocks.findIndex(isContent);
    if (first < 0) continue;
    if (!isProse(blocks[first])) return clip(blocks[first].text, max);
    let out = '';
    for (const block of blocks.slice(first)) {
      const introduces = /[:：]$/.test(out);
      if (!isProse(block) && !(introduces && (isContentList(block) || block.data))) continue;
      out = out ? `${out} ${block.text}` : block.text;
      if (out.length >= max * 0.8) break;
    }
    return clip(out, max);
  }
  for (const kind of ['list', 'table', 'text', 'heading'] as const) {
    for (const blocks of pages) {
      const text = blocks.filter((b) => b.kind === kind && readable(b.text)).map((b) => b.text).join(kind === 'table' ? '；' : ' ');
      if (text) return clip(text, max);
    }
  }
  return '';
}
