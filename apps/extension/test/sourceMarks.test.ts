import type { SourceId } from '@kiwi-search/core';
import { readdirSync, readFileSync } from 'node:fs';
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

  it('has a logo for every mark a source points to, and none that no source uses', () => {
    for (const { mark } of Object.values(SOURCE_MARKS)) expect(MARK_ART[mark].src, mark).toMatch(/^data:image\/(svg\+xml|png);base64,/);
    expect(Object.keys(MARK_ART).sort()).toEqual([...new Set(Object.values(SOURCE_MARKS).map((m) => m.mark))].sort());
  });
});

describe('engine logos', () => {
  const dir = new URL('../assets/engine-logos/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('logos.json', dir), 'utf8')) as Record<string, { file: string; dark?: string; from: string; license: string }>;

  it('are real logos with a stated origin and licence, never something drawn for Kiwi', () => {
    for (const [key, entry] of Object.entries(manifest)) {
      expect(entry.from.length, key).toBeGreaterThan(10);
      expect(entry.license, key).toMatch(/CC0|CC-BY|brand/);
    }
  });

  it('are all listed, and every file is used', () => {
    const used = new Set(Object.values(manifest).flatMap((e) => [e.file, e.dark].filter(Boolean)));
    const files = readdirSync(dir).filter((f) => /\.(svg|png)$/.test(f));
    expect([...used].sort()).toEqual(files.sort());
    expect(Object.keys(manifest).sort()).toEqual(Object.keys(MARK_ART).sort());
  });

  it('are named in NOTICE.md with their licence', () => {
    const notice = readFileSync(new URL('NOTICE.md', dir), 'utf8');
    for (const [key, entry] of Object.entries(manifest)) expect(notice, key).toContain(entry.file);
    expect(notice).toMatch(/Font Awesome/);
  });

  it('carry no script', () => {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.svg'))) expect(readFileSync(new URL(f, dir), 'utf8'), f).not.toMatch(/<script|onload\s*=|javascript:/i);
  });

  it('give an engine seen through a dark variant a different image', () => {
    for (const [key, art] of Object.entries(MARK_ART) as [string, { src: string; dark?: string }][]) if (art.dark) expect(art.dark, key).not.toBe(art.src);
  });
});
