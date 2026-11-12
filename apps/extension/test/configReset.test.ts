import { DEFAULT_CONFIG } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import { resetKeepingSecrets, tidyConfig } from '../lib/configReset';

describe('resetKeepingSecrets', () => {
  it('restores the defaults but keeps what the user typed that is tedious to get back', () => {
    const current = structuredClone(DEFAULT_CONFIG);
    current.sources.google = { enabled: false };
    current.sources.brave = { enabled: true, apiKey: 'brave-key' };
    current.sources.searxng = { enabled: true, baseUrl: 'https://searx.example', apiKey: 'bearer' };
    current.judge.apiKey = 'jev';
    current.judge.llm = { baseUrl: 'https://fast.example/v1', apiKey: 'fast-key', model: 'small' };
    current.judge.llmShared = false;
    current.judge.rules = ['a rule'];
    current.judge.blockedDomains = ['x.com'];
    current.llm.apiKey = 'llm-key';
    current.perSourceCount = 3;
    const next = resetKeepingSecrets(current);
    expect(next.sources.google?.enabled).toBe(true);
    expect(next.sources.brave).toEqual({ ...DEFAULT_CONFIG.sources.brave, apiKey: 'brave-key' });
    expect(next.sources.searxng).toMatchObject({ baseUrl: 'https://searx.example', apiKey: 'bearer' });
    expect([next.judge.apiKey, next.llm.apiKey]).toEqual(['jev', 'llm-key']);
    expect(next.judge.llm).toEqual({ baseUrl: 'https://fast.example/v1', apiKey: 'fast-key', model: 'small' });
    expect(next.judge.llmShared).toBe(true);
    expect(next.judge.rules).toEqual([]);
    expect(next.judge.blockedDomains).toEqual([]);
    expect(next.perSourceCount).toBe(DEFAULT_CONFIG.perSourceCount);
  });

  it('does not hand back the defaults object itself', () => {
    const next = resetKeepingSecrets(structuredClone(DEFAULT_CONFIG));
    next.judge.rules.push('x');
    expect(DEFAULT_CONFIG.judge.rules).toEqual([]);
  });
});

describe('tidyConfig', () => {
  it('drops blank and repeated lines from the rule and site lists', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.judge.rules = ['', ' keep me ', 'keep me', '  '];
    config.judge.blockedDomains = ['a.com', '', 'a.com'];
    const tidy = tidyConfig(config);
    expect(tidy.judge.rules).toEqual(['keep me']);
    expect(tidy.judge.blockedDomains).toEqual(['a.com']);
  });
});
