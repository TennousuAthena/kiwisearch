import type { SourceId } from '@kiwi-search/core';
import { describe, expect, it } from 'vitest';
import { MARK_ART } from '../lib/sourceIcons';
import { marksLabel, SOURCE_MARKS, sourceMarks } from '../lib/sourceMarks';

const from = (...pairs: [SourceId, number][]) => pairs.map(([source, rank]) => ({ source, rank }));

describe('sourceMarks', () => {
  it('shows nothing for a result only one engine returned', () => {
    expect(sourceMarks(from(['google', 1]))).toEqual([]);
    expect(sourceMarks([])).toEqual([]);
  });

  it('lists the engines that agree, best rank first', () => {
    const marks = sourceMarks(from(['bing', 4], ['google', 1], ['baidu', 2]));
    expect(marks.map((m) => m.name)).toEqual(['Google', '百度', 'Bing']);
  });

  it('keeps arrival order between equal ranks', () => {
    expect(sourceMarks(from(['bing', 1], ['google', 1])).map((m) => m.mark)).toEqual(['bing', 'google']);
  });

  it('counts the two Xiaohongshu sites as one platform', () => {
    expect(sourceMarks(from(['xiaohongshu', 1], ['rednote', 2]))).toEqual([]);
    expect(sourceMarks(from(['xiaohongshu', 1], ['rednote', 2], ['google', 3])).map((m) => m.name)).toEqual(['小红书', 'Google']);
  });

  it('does not mutate the result it reads', () => {
    const sources = from(['bing', 4], ['google', 1]);
    sourceMarks(sources);
    expect(sources.map((s) => s.source)).toEqual(['bing', 'google']);
  });

  it('says "收录", never "验证"', () => {
    const label = marksLabel(sourceMarks(from(['google', 1], ['baidu', 2])));
    expect(label).toBe('Google、百度 都收录了这条结果');
    expect(label).not.toMatch(/验证/);
  });

  it('has art for every mark a source points to', () => {
    for (const { mark } of Object.values(SOURCE_MARKS)) {
      const art: { path?: string; letter?: string } = MARK_ART[mark];
      expect(art.path || art.letter, mark).toBeTruthy();
    }
  });

  it('keeps every colour a plain hex value', () => {
    for (const [key, art] of Object.entries(MARK_ART)) {
      expect(art.color, key).toMatch(/^#[0-9A-F]{6}$/);
      expect(art.colorDark, key).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});
