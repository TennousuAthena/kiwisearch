import { describe, expect, it } from 'vitest';
import { justifiedRows } from '../lib/justify';

describe('justifiedRows', () => {
  it('scales full rows to the exact width, gaps included', () => {
    const rows = justifiedRows([1.5, 1, 2, 1, 1.5, 1], 800, 200, 8);
    for (const row of rows.slice(0, -1)) {
      const used = row.items.reduce((sum, item) => sum + item.width, 0) + 8 * (row.items.length - 1);
      expect(used).toBeCloseTo(800, 5);
    }
  });

  it('keeps the target height on the last, partly filled row', () => {
    const rows = justifiedRows([1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5], 800, 200, 8);
    const last = rows[rows.length - 1];
    expect(last.height).toBe(200);
    expect(last.items.reduce((sum, item) => sum + item.width, 0)).toBeLessThan(800);
  });

  it('keeps every image in order and with its own aspect ratio', () => {
    const ratios = [1.5, 0.5, 2, 1, 3, 1.2, 0.8];
    const rows = justifiedRows(ratios, 600, 150, 4);
    const flat = rows.flatMap((row) => row.items);
    expect(flat.map((item) => item.index)).toEqual(ratios.map((_, i) => i));
    for (const item of flat) expect(item.width / item.height).toBeCloseTo(ratios[item.index], 5);
  });

  it('falls back to 4:3 for unknown sizes and clamps extreme ratios', () => {
    const [row] = justifiedRows([NaN, 0, -1, 100], 10_000, 100, 0);
    const ratios = row.items.map((item) => item.width / item.height);
    [4 / 3, 4 / 3, 4 / 3, 4].forEach((expected, i) => expect(ratios[i]).toBeCloseTo(expected, 9));
  });

  it('handles empty input and an unmeasured container', () => {
    expect(justifiedRows([], 800, 200, 8)).toEqual([]);
    expect(justifiedRows([1, 1], 0, 200, 8)).toEqual([]);
  });

  it('puts a lone very wide image on its own row', () => {
    const rows = justifiedRows([4], 300, 200, 8);
    expect(rows).toHaveLength(1);
    expect(rows[0].height).toBeCloseTo(75, 5);
  });
});
