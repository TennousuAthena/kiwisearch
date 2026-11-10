import type { ChatMessage } from './llm';
import type { Citation, FusedResult } from './types';

export function buildCitations(results: FusedResult[]): Citation[] {
  return results.map((r, i) => ({ n: i + 1, url: r.url, title: r.title }));
}

export function buildSummaryMessages(
  query: string,
  results: FusedResult[],
  contents: Map<string, string>,
  instructions?: string,
  now = new Date(),
): ChatMessage[] {
  const context = results
    .map((r, i) => {
      const body = contents.get(r.key) || r.snippet;
      const date = r.publishedAt ? ` (${r.publishedAt.slice(0, 10)})` : '';
      return `[${i + 1}] ${r.title}${date}\nURL: ${r.url}\n${body}`;
    })
    .join('\n\n---\n\n');
  const system = [
    'You are a search assistant that writes a concise, well-structured answer grounded ONLY in the numbered sources provided.',
    'Rules:',
    '- Answer in the same language as the query.',
    '- Cite sources inline with bracketed numbers like [1] or [2][5] right after the claim they support. Only cite numbers that exist.',
    '- Start with a direct 1-3 sentence answer, then key points as a short Markdown list when useful.',
    '- If sources disagree, say so. If they do not contain the answer, say what is missing instead of guessing.',
    '- No preamble, no closing remarks, no separate reference list.',
    `- Today is ${now.toISOString().slice(0, 10)}.`,
    instructions ? `Additional instructions: ${instructions}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Sources:\n\n${context}\n\n===\nQuery: ${query}` },
  ];
}
