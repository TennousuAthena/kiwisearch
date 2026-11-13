import { describe, expect, it } from 'vitest';
import { isExtensionPageSender, parseSummaryRequest } from '../lib/summaryRequest';
const request = () => ({ type: 'summarize', query: 'q', mode: 'web', results: [{ key: 'a', url: 'https://example.com/a', title: 'a', snippet: 'text', sources: [], meta: {} }] });
describe('summary port boundaries', () => {
  it('accepts only this extension page identity, including URL query/hash', () => {
    expect(isExtensionPageSender({ id: 'own', url: 'chrome-extension://own/newtab.html?q=x#cite' }, 'own', 'chrome-extension://own/')).toBe(true);
    for (const url of ['https://example.com/newtab.html', 'chrome-extension://other/newtab.html', 'chrome-extension://own/content.js']) expect(isExtensionPageSender({ id: 'own', url }, 'own', 'chrome-extension://own/')).toBe(false);
    expect(isExtensionPageSender({ id: 'other', url: 'chrome-extension://own/newtab.html' }, 'own', 'chrome-extension://own/')).toBe(false);
  });
  it('clones valid snapshots and rejects oversized, malformed or unsafe input', () => {
    const value = request(); expect(parseSummaryRequest(value)).toEqual(value); expect(parseSummaryRequest(value)).not.toBe(value);
    expect(parseSummaryRequest({ ...value, query: 'x'.repeat(4097) })).toBeNull();
    expect(parseSummaryRequest({ ...value, mode: 'images' })).toBeNull();
    expect(parseSummaryRequest({ ...value, results: Array.from({ length: 101 }, () => value.results[0]) })).toBeNull();
    expect(parseSummaryRequest({ ...value, results: [{ ...value.results[0], url: 'javascript:alert(1)' }] })).toBeNull();
    expect(parseSummaryRequest({ ...value, results: [{ ...value.results[0], meta: { authors: 'bad' } }] })).toBeNull();
    expect(parseSummaryRequest({ ...value, results: [{ ...value.results[0], publishedAt: 42 }] })).toBeNull();
  });
});
