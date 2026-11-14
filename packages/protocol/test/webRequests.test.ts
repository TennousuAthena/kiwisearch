import { describe, expect, it } from 'vitest';
import {
  createRateLimiter, parseAcademicLanguageSaveParams, parseDomainPreferenceParams, parseFaviconParams, parseFocusWorkerParams, parseOpenLocalParams,
  parseOpenOptionsParams, parsePrefsSaveParams, parseSearchStreamMessage, parseSummaryStreamMessage, parseUndoParams, SEARCH_MODES,
} from '../src';

describe('what a website may ask for', () => {
  it('accepts a host name for a site icon and nothing that could be a path, a query or a credential', () => {
    expect(parseFaviconParams({ host: 'example.com' })).toEqual({ host: 'example.com' });
    for (const host of ['', 'a b.com', 'a.com/x', 'a.com?x', 'user@a.com', 'a.com#x', 'x'.repeat(254), 5, undefined]) expect(parseFaviconParams({ host }), String(host)).toBeNull();
    expect(parseFaviconParams('example.com')).toBeNull();
  });

  it('accepts a source id for a worker tab and no other text', () => {
    expect(parseFocusWorkerParams({ source: 'google' })).toEqual({ source: 'google' });
    for (const source of ['', 'Google', 'a b', '../x', 'x'.repeat(41), 3]) expect(parseFocusWorkerParams({ source }), String(source)).toBeNull();
  });

  it('reduces a blocked or boosted site to a bare host name and ignores whatever else the page adds', () => {
    expect(parseDomainPreferenceParams({ action: 'block', domain: 'https://www.CSDN.net/a?b=1', extra: { config: 1 } })).toEqual({ action: 'block', domain: 'csdn.net' });
    expect(parseDomainPreferenceParams({ action: 'delete', domain: 'a.com' })).toBeNull();
    expect(parseDomainPreferenceParams({ action: 'block', domain: 'not a host' })).toBeNull();
    expect(parseDomainPreferenceParams({ action: 'block', domain: 'a.com'.padEnd(300, 'a') })).toBeNull();
  });

  it('builds an undo receipt from checked fields only', () => {
    const undo = { domain: 'A.com', before: { blocked: false, boosted: false, x: 1 }, after: { blocked: true, boosted: false }, revision: 'r1', other: 'x' };
    expect(parseUndoParams({ undo })).toEqual({ undo: { domain: 'a.com', before: { blocked: false, boosted: false }, after: { blocked: true, boosted: false }, revision: 'r1' } });
    expect(parseUndoParams({ undo: { ...undo, revision: '' } })).toBeNull();
    expect(parseUndoParams({ undo: { ...undo, revision: 'r'.repeat(65) } })).toBeNull();
    expect(parseUndoParams({ undo: { ...undo, before: { blocked: 'yes', boosted: false } } })).toBeNull();
    expect(parseUndoParams({ undo: { ...undo, domain: 'nope' } })).toBeNull();
  });

  it('lets a page save the four interface preferences and nothing else', () => {
    expect(parsePrefsSaveParams({ values: { 'ui:theme': 'dark', 'ui:openNewTab': false } })).toEqual({ values: { 'ui:theme': 'dark', 'ui:openNewTab': false } });
    for (const values of [{ config: {} }, { 'ui:theme': 'purple' }, { 'ui:summaryMode': true }, { 'ui:theme': 'dark', bridge: { token: 'x' } }, {}, [], null]) {
      expect(parsePrefsSaveParams({ values }), JSON.stringify(values)).toBeNull();
    }
  });

  it('knows the two academic language values', () => {
    expect(parseAcademicLanguageSaveParams({ language: 'en' })).toEqual({ language: 'en' });
    expect(parseAcademicLanguageSaveParams({ language: 'fr' })).toBeNull();
  });

  it('accepts a query and a known mode to open in the extension, and a short section name for the settings', () => {
    expect(parseOpenLocalParams({ query: 'hello world' })).toEqual({ query: 'hello world', mode: 'web' });
    expect(parseOpenLocalParams({ query: 'a', mode: 'images' })).toEqual({ query: 'a', mode: 'images' });
    expect(parseOpenLocalParams({ query: 'a', mode: 'admin' })).toBeNull();
    expect(parseOpenLocalParams({ query: 'x'.repeat(4097) })).toBeNull();
    expect(parseOpenOptionsParams(undefined)).toEqual({});
    expect(parseOpenOptionsParams({ section: 'sources' })).toEqual({ section: 'sources' });
    expect(parseOpenOptionsParams({ section: '../x' })).toBeNull();
  });
});

describe('what a website may send on a search stream', () => {
  it('copies the known fields of a search and drops the rest', () => {
    expect(parseSearchStreamMessage({ type: 'search', query: 'q', mode: 'news', news: { range: '7d', sort: 'date' }, sources: ['google', 'bing'], summarize: true, refresh: false, language: 'en', evil: 1 }))
      .toEqual({ type: 'search', query: 'q', mode: 'news', news: { range: '7d', sort: 'date' }, sources: ['google', 'bing'], summarize: true, refresh: false, language: 'en' });
    expect(parseSearchStreamMessage({ type: 'keepalive', x: 1 })).toEqual({ type: 'keepalive' });
    expect(parseSearchStreamMessage({ type: 'stop-summary' })).toEqual({ type: 'stop-summary' });
  });

  it('refuses a search that is empty, too long, or has fields of the wrong kind', () => {
    for (const bad of [{ type: 'search', query: '  ' }, { type: 'search', query: 'x'.repeat(4097) }, { type: 'search', query: 'q', mode: 'admin' }, { type: 'search', query: 'q', sources: 'google' },
      { type: 'search', query: 'q', sources: Array.from({ length: 61 }, () => 'a') }, { type: 'search', query: 'q', sources: ['../x'] }, { type: 'search', query: 'q', news: { range: '7d', sort: 'date', since: 1 } },
      { type: 'search', query: 'q', news: { range: 'x'.repeat(25) } }, { type: 'search', query: 'q', summarize: 'yes' }, { type: 'search', query: 'q', language: 'fr' }, { type: 'other' }, null, 'search']) {
      expect(parseSearchStreamMessage(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('takes a summary request or the stop and keepalive messages on the summary stream', () => {
    expect(parseSummaryStreamMessage({ type: 'keepalive' })).toEqual({ type: 'keepalive' });
    expect(parseSummaryStreamMessage({ type: 'search', query: 'q' })).toBeNull();
  });

  it('lists the same modes as core (the full check against core is in the extension tests)', () => {
    expect(SEARCH_MODES).toHaveLength(10);
  });
});

describe('rate limit', () => {
  it('allows a number of calls per window for each key and forgets old calls', () => {
    let now = 0;
    const allow = createRateLimiter(2, 1000, () => now);
    expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
    now = 1001;
    expect(allow('a')).toBe(true);
  });
});
