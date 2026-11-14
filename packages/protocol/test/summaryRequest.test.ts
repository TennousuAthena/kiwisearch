import { describe, expect, it } from 'vitest';
import { parseSummaryRequest } from '../src';

const request = () => ({ type: 'summarize', query: 'q', mode: 'web', results: [{ key: 'a', url: 'https://example.com/a', title: 'a', snippet: 'text', sources: [], meta: {} }] });
describe('summary request boundaries', () => {
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
