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
