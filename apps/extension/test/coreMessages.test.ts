import { DEFAULT_CORE_MESSAGES } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import { coreMessagesFor } from '@kiwi-search/app/i18n/coreMessages';

// Core words these sentences itself when nobody gives it better ones (MCP, tests); the extension words them from its catalog.
// In the language the catalog is written in, the two must say the same thing.
describe('the sentences core asks the extension for', () => {
  const ours = coreMessagesFor();

  it('match core\'s own defaults in the source language', () => {
    for (const [key, theirs] of Object.entries(DEFAULT_CORE_MESSAGES)) {
      const mine = ours[key as keyof typeof ours];
      expect(typeof mine, key).toBe(typeof theirs);
      if (typeof theirs === 'function') expect((mine as (ms: number) => string)(6000), key).toBe(theirs(6000));
      else expect(mine, key).toBe(theirs);
    }
  });

  it('covers every sentence core has', () => {
    expect(Object.keys(ours).sort()).toEqual(Object.keys(DEFAULT_CORE_MESSAGES).sort());
  });
});
