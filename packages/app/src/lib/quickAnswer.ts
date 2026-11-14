import type { SearchState } from './searchState';

export interface QuickAnswerContent {
  headline: string;
  detail: string;
  /** Any following overview text keeps its original citation numbering. */
  remainder: string;
}

type SummaryInput = Pick<SearchState, 'mode' | 'summary' | 'summaryStatus' | 'citations'>;

/** A web summary reserves its first H1 for a short, source-backed factual answer.
 * Incomplete or malformed model output remains an ordinary overview. This checks
 * the presentation contract and citation references, not the truth of a claim.
 */
export function extractQuickAnswer(state: SummaryInput): QuickAnswerContent | null {
  if (state.mode !== 'web' || !['streaming', 'done'].includes(state.summaryStatus)) return null;
  const text = state.summary.replace(/\r\n?/g, '\n').trimStart();
  const heading = /^# ([^\n]+)\n[ \t]*\n/.exec(text);
  if (!heading) return null;
  const headline = heading[1].trim();
  // React renders this as text. Reject formatting instead of exposing raw markup
  // or silently changing the model's answer by truncating it.
  if (!headline || [...headline].length > 100 || /[<>\[\]`*_#\\\u0000-\u001f\u007f]/.test(headline)) return null;

  const body = text.slice(heading[0].length);
  const boundary = /\n[ \t]*\n/.exec(body);
  if (!boundary && state.summaryStatus !== 'done') return null;
  const detail = (boundary ? body.slice(0, boundary.index) : body).trim();
  if (!detail || [...detail].length > 700) return null;
  // The compact detail is prose, never a heading, list, table or code block.
  if (/(?:^|\n)[ \t]*(?:#{1,6}(?:\s|$)|[-*+]\s|\d+[.)]\s|>|```|~~~|\|)/.test(detail)) return null;

  const citations = [...detail.matchAll(/\[(\d+)\]/g)];
  if (!citations.length) return null;
  const byNumber = new Map(state.citations.map((citation) => [citation.n, citation]));
  for (const match of citations) {
    // Markdown links and escaped/code markers are not source citations. The
    // renderer supports one- and two-digit, unescaped [n] references.
    const offset = match.index ?? 0;
    const following = detail.slice(offset + match[0].length);
    if (match[1].length > 2 || match[1].startsWith('0') || /[\\`!]/.test(detail[offset - 1] ?? '') || following.startsWith('(') || /^\[(?!\d+\])/.test(following)) return null;
    const citation = byNumber.get(Number(match[1]));
    if (!citation) return null;
    try {
      if (!['http:', 'https:'].includes(new URL(citation.url).protocol)) return null;
    } catch {
      return null;
    }
  }
  // Citation-like strings inside code or HTML do not establish visible evidence.
  if (/[`<>]/.test(detail)) return null;

  return {
    headline,
    detail,
    remainder: boundary ? body.slice(boundary.index + boundary[0].length).trim() : '',
  };
}
