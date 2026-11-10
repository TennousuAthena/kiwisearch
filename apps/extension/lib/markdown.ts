import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Render LLM markdown and turn [n] markers into citation links. */
export function renderSummary(md: string, citations: { n: number; url: string }[]): string {
  const byN = new Map(citations.map((c) => [c.n, c.url]));
  const withCites = md.replace(/\[(\d{1,2})\](?!\()/g, (m, n: string) => {
    const url = byN.get(Number(n));
    return url ? `<a class="cite" data-n="${n}" href="${url}" target="_blank" rel="noreferrer">${n}</a>` : m;
  });
  const html = marked.parse(withCites, { async: false, gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-n'] });
}
