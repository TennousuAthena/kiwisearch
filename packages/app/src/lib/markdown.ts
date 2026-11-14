import DOMPurify from 'dompurify';
import { marked } from 'marked';

const escapeAttr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Render LLM markdown and turn [n] markers into citation links titled with the cited page. */
export function renderSummary(md: string, citations: { n: number; url: string; title?: string }[]): string {
  const byN = new Map(citations.map((c) => [c.n, c]));
  const withCites = md.replace(/\[(\d{1,2})\](?!\()/g, (m, n: string) => {
    const cited = byN.get(Number(n));
    if (!cited) return m;
    const title = cited.title ? ` title="${escapeAttr(cited.title)}"` : '';
    return `<a class="cite" data-n="${n}" href="${escapeAttr(cited.url)}"${title} target="_blank" rel="noreferrer">${n}</a>`;
  });
  const html = marked.parse(withCites, { async: false, gfm: true, breaks: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-n'] });
}
