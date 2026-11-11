import type { IntentSuggestion, SearchMode, SuggestMode } from '@kiwi-search/core';

/** The state a decision needs; a slice of `SearchState`. */
export interface SuggestionContext {
  query: string;
  mode: SearchMode;
  stage: 'searching' | 'refining' | 'done';
  resultCount: number;
  suggest?: IntentSuggestion;
}

export type SuggestionAction =
  /** Move to this tab now: results of the general list aren't on screen yet, so nothing is taken away from the user. */
  | { kind: 'switch'; mode: SuggestMode }
  /** Leave the page as it is and offer the tab in one quiet line. Not made once the user has said to stay on the web results. */
  | { kind: 'offer'; mode: SuggestMode };

/**
 * What to do with the decision model's tab suggestion.
 * - Only a general search is ever redirected; an explicit tab is the user's choice.
 * - It switches by itself only when it is sure, the search was typed (not a Back or a reload), the user hasn't already
 *   said "stay on the web results" for this query, and no results are showing: a page that moves under a reader's eyes is worse than no hint.
 * - In every other case it offers, except after "stay on the web results": the user has answered.
 */
export function decideSuggestion(ctx: SuggestionContext, opts: { autoAllowed: boolean; declinedQuery: string | null }): SuggestionAction | null {
  const suggest = ctx.suggest;
  if (!suggest || ctx.mode !== 'web' || opts.declinedQuery === ctx.query) return null;
  if (suggest.strong && opts.autoAllowed && ctx.resultCount === 0 && ctx.stage === 'searching') {
    return { kind: 'switch', mode: suggest.mode };
  }
  return { kind: 'offer', mode: suggest.mode };
}

const NAMES: Record<SuggestMode, string> = { images: '图片', video: '视频', academic: '学术' };
export const suggestionName = (mode: SuggestMode): string => NAMES[mode];

/** "看起来你在找图片" and its siblings, for the offer line. */
export function offerText(mode: SuggestMode): string {
  return mode === 'academic' ? '看起来你在找论文' : mode === 'video' ? '看起来你想看视频' : '看起来你在找图片';
}
