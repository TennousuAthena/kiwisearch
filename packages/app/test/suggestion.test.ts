import { describe, expect, it } from 'vitest';
import { decideSuggestion, offerText, suggestionName, type SuggestionContext } from '../src/lib/suggestion';

const ctx = (patch: Partial<SuggestionContext> = {}): SuggestionContext => ({
  query: 'puppy photos',
  mode: 'web',
  stage: 'searching',
  resultCount: 0,
  suggest: { mode: 'images', score: 0.93, strong: true },
  ...patch,
});
const typed = { autoAllowed: true, declinedQuery: null };

describe('decideSuggestion', () => {
  it('does nothing without a suggestion, or outside a general search', () => {
    expect(decideSuggestion(ctx({ suggest: undefined }), typed)).toBeNull();
    expect(decideSuggestion(ctx({ mode: 'images' }), typed)).toBeNull();
    expect(decideSuggestion(ctx({ mode: 'academic' }), typed)).toBeNull();
  });

  it('moves to the tab by itself when sure and nothing is on screen yet', () => {
    expect(decideSuggestion(ctx(), typed)).toEqual({ kind: 'switch', mode: 'images' });
  });

  it('only offers when the model is not sure enough', () => {
    expect(decideSuggestion(ctx({ suggest: { mode: 'video', score: 0.7, strong: false } }), typed)).toEqual({ kind: 'offer', mode: 'video' });
  });

  it('never moves a page that already shows results', () => {
    expect(decideSuggestion(ctx({ resultCount: 3 }), typed)).toEqual({ kind: 'offer', mode: 'images' });
    expect(decideSuggestion(ctx({ stage: 'done' }), typed)).toEqual({ kind: 'offer', mode: 'images' });
  });

  it('does not take over a Back or a reload, and says nothing more after "stay on the web results"', () => {
    expect(decideSuggestion(ctx(), { autoAllowed: false, declinedQuery: null })).toEqual({ kind: 'offer', mode: 'images' });
    expect(decideSuggestion(ctx(), { autoAllowed: true, declinedQuery: 'puppy photos' })).toBeNull();
    expect(decideSuggestion(ctx(), { autoAllowed: true, declinedQuery: 'another query' })).toEqual({ kind: 'switch', mode: 'images' });
  });

  it('has words for each tab', () => {
    expect(suggestionName('academic')).toBe('学术');
    expect(offerText('academic')).toMatch(/“学术”/);
    expect(offerText('video')).toMatch(/“视频”/);
    expect(offerText('images')).toMatch(/“图片”/);
  });
});
