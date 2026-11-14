export interface JustifiedItem {
  index: number;
  width: number;
  height: number;
}

export interface JustifiedRow {
  height: number;
  items: JustifiedItem[];
}

/**
 * Flickr-style rows: fill each row with images until it is at least `width` wide at `targetHeight`,
 * then scale the row down so it fits exactly. The last row keeps `targetHeight` rather than
 * stretching a couple of leftover images across the page.
 */
export function justifiedRows(ratios: number[], width: number, targetHeight: number, gap: number): JustifiedRow[] {
  if (width <= 0 || !ratios.length) return [];
  const rows: JustifiedRow[] = [];
  let current: { index: number; ratio: number }[] = [];
  let ratioSum = 0;
  const flush = (height: number) => {
    rows.push({
      height,
      items: current.map(({ index, ratio }) => ({ index, width: ratio * height, height })),
    });
    current = [];
    ratioSum = 0;
  };
  ratios.forEach((raw, index) => {
    const ratio = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw, 0.25), 4) : 4 / 3;
    current.push({ index, ratio });
    ratioSum += ratio;
    if (ratioSum * targetHeight + gap * (current.length - 1) >= width) {
      flush((width - gap * (current.length - 1)) / ratioSum);
    }
  });
  if (current.length) flush(targetHeight);
  return rows;
}
