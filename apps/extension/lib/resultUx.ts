import type { Citation } from '@kiwi-search/core';

/** Preserve citation numbers and append the actual cited URLs when copying an answer. */
export function summaryCopyText(markdown: string, citations: Citation[], sourceHeading: string): string {
  const used = new Set([...markdown.matchAll(/\[(\d+)\](?!\()/g)].map((match) => Number(match[1])));
  const seen = new Set<number>();
  const lines = citations.filter((citation) => {
    if (!used.has(citation.n) || seen.has(citation.n) || !/^https?:\/\//i.test(citation.url)) return false;
    seen.add(citation.n); return true;
  }).map((citation) => `[${citation.n}] ${citation.title.replace(/\s+/g, ' ').trim()}\n${citation.url}`);
  return [markdown.trim(), ...(lines.length ? [sourceHeading, lines.join('\n\n')] : [])].join('\n\n');
}
