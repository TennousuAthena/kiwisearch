import { DEFAULT_CONFIG } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import { configForPage } from '../lib/searchConfig';

describe('the configuration a page searches with', () => {
  it('keeps the early overview for a page that says it understands it', () => {
    expect(configForPage(DEFAULT_CONFIG, true)).toBe(DEFAULT_CONFIG);
    expect(DEFAULT_CONFIG.summary.early.enabled).toBe(true);
  });

  it('turns it off for any other page, without touching the saved settings or anything else', () => {
    for (const says of [undefined, false]) {
      const config = configForPage(DEFAULT_CONFIG, says);
      expect(config.summary.early.enabled).toBe(false);
      expect(config.summary).toEqual({ ...DEFAULT_CONFIG.summary, early: { ...DEFAULT_CONFIG.summary.early, enabled: false } });
      expect({ ...config, summary: undefined }).toEqual({ ...DEFAULT_CONFIG, summary: undefined });
    }
    expect(DEFAULT_CONFIG.summary.early.enabled).toBe(true);
  });

  it('returns the same configuration when the early overview is already off', () => {
    const off = structuredClone(DEFAULT_CONFIG);
    off.summary.early.enabled = false;
    expect(configForPage(off, undefined)).toBe(off);
  });
});
