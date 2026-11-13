import { DEFAULT_CONFIG } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import { sourceNeedsAttention, sourcePresetUndo, undoSourcePreset } from '../lib/sourceControls';

describe('sources requiring attention', () => {
  it('includes enabled sources missing credentials or an address and actual failures', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sources.brave = { enabled: true };
    config.sources.searxng = { enabled: true };
    config.sources.zhihu = { enabled: true };
    config.sources.google = { enabled: true };
    expect(sourceNeedsAttention('brave', config)).toBe(true);
    expect(sourceNeedsAttention('searxng', config)).toBe(true);
    expect(sourceNeedsAttention('zhihu', config, { state: 'login', at: 1 })).toBe(true);
    expect(sourceNeedsAttention('google', config, { state: 'captcha', at: 1 })).toBe(true);
    expect(sourceNeedsAttention('google', config, { state: 'error', at: 1, message: 'timeout' })).toBe(true);
  });

  it('does not classify untried, empty, ready or disabled sources as failures', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sources.zhihu = { enabled: true };
    config.sources.google = { enabled: true };
    config.sources.brave = { enabled: false };
    expect(sourceNeedsAttention('zhihu', config)).toBe(false);
    expect(sourceNeedsAttention('google', config)).toBe(false);
    expect(sourceNeedsAttention('google', config, { state: 'empty', at: 1 })).toBe(false);
    expect(sourceNeedsAttention('google', config, { state: 'ok', at: 1, count: 3 })).toBe(false);
    expect(sourceNeedsAttention('brave', config, { state: 'error', at: 1, message: 'timeout' })).toBe(false);
  });
});

describe('group preset undo', () => {
  it('records only switches changed by the preset and restores no other settings', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sources.arxiv = { enabled: true };
    config.sources.openalex = { enabled: true, apiKey: 'original' };
    const undo = sourcePresetUndo(config, { arxiv: false, openalex: true })!;
    expect(undo).toEqual({ before: { arxiv: true }, after: { arxiv: false } });
    const current = structuredClone(config);
    current.sources.arxiv = { enabled: false, weight: 2 };
    current.sources.openalex!.apiKey = 'edited';
    current.sources.google = { enabled: false };
    expect(undoSourcePreset(current, undo)).toEqual({ arxiv: true });
    expect(current.sources.openalex?.apiKey).toBe('edited');
    expect(current.sources.arxiv.weight).toBe(2);
    expect(current.sources.google.enabled).toBe(false);
  });

  it('does not replace a prior undo for a no-op preset and preserves later switch choices', () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sources.arxiv = { enabled: true };
    config.sources.dblp = { enabled: true };
    expect(sourcePresetUndo(config, { arxiv: true })).toBeNull();
    const undo = sourcePresetUndo(config, { arxiv: false, dblp: false })!;
    const current = structuredClone(config);
    current.sources.arxiv!.enabled = true;
    current.sources.dblp!.enabled = false;
    expect(undoSourcePreset(current, undo)).toEqual({ dblp: true });
  });
});
