import type { FusedResult } from '@kiwi-search/core';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, ArrowRightIcon, CloseIcon, ExternalLinkIcon } from '@/lib/icons';
import { justifiedRows } from '@/lib/justify';
import { hostOf } from '@/lib/results';

const GAP = 8;
const target = (width: number) => (width < 520 ? 120 : width < 900 ? 160 : 200);
const ratioOf = (result: FusedResult) => {
  const { width, height } = result.image ?? {};
  return width && height ? width / height : NaN;
};

export function ImageResults({ results }: { results: FusedResult[] }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [broken, setBroken] = useState<Set<string>>(() => new Set());

  // Thumbnails that fail to load drop out of the layout instead of leaving holes.
  const shown = useMemo(() => results.filter((r) => r.image && !broken.has(r.key)), [results, broken]);
  const rows = useMemo(() => justifiedRows(shown.map(ratioOf), width, target(width), GAP), [shown, width]);
  const selectedIndex = shown.findIndex((r) => r.key === selectedKey);
  const selected = selectedIndex >= 0 ? shown[selectedIndex] : null;

  // The grid's width changes when the preview opens, so lay out from what the grid actually has.
  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    setWidth(Math.floor(element.clientWidth));
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedKey(null);
      else if (event.key === 'ArrowRight' && selectedIndex < shown.length - 1) setSelectedKey(shown[selectedIndex + 1].key);
      else if (event.key === 'ArrowLeft' && selectedIndex > 0) setSelectedKey(shown[selectedIndex - 1].key);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, selectedIndex, shown]);

  return (
    <div className={selected ? 'images with-preview' : 'images'}>
      <div className="image-grid" ref={gridRef}>
        {rows.map((row) => (
          <div className="image-row" key={row.items[0].index} style={{ height: row.height }}>
            {row.items.map((item) => {
              const result = shown[item.index];
              return (
                <button
                  key={result.key}
                  type="button"
                  className="image-tile"
                  aria-pressed={result.key === selectedKey}
                  aria-label={result.title}
                  title={result.title}
                  style={{ width: item.width, height: item.height }}
                  onClick={() => setSelectedKey(result.key === selectedKey ? null : result.key)}
                >
                  <img
                    src={result.image!.thumbnail}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={() => setBroken((current) => new Set(current).add(result.key))}
                  />
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {selected && (
        <ImagePreview
          key={selected.key}
          result={selected}
          onClose={() => setSelectedKey(null)}
          onPrevious={selectedIndex > 0 ? () => setSelectedKey(shown[selectedIndex - 1].key) : undefined}
          onNext={selectedIndex < shown.length - 1 ? () => setSelectedKey(shown[selectedIndex + 1].key) : undefined}
        />
      )}
    </div>
  );
}

function ImagePreview({
  result,
  onClose,
  onPrevious,
  onNext,
}: {
  result: FusedResult;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const image = result.image!;
  // Many hosts block hot-linking; fall back to the thumbnail rather than a broken image.
  const [useThumbnail, setUseThumbnail] = useState(false);
  const size = image.width && image.height ? `${image.width} × ${image.height}` : '';
  const facts = [size, image.license, image.creator].filter(Boolean).join(' · ');
  return (
    <aside className="preview" aria-label="图片预览">
      <div className="preview-bar">
        <button type="button" className="icon-btn" onClick={onPrevious} disabled={!onPrevious} aria-label="上一张">
          <ArrowLeftIcon />
        </button>
        <button type="button" className="icon-btn" onClick={onNext} disabled={!onNext} aria-label="下一张">
          <ArrowRightIcon />
        </button>
        <button type="button" className="icon-btn preview-close" onClick={onClose} aria-label="关闭预览">
          <CloseIcon />
        </button>
      </div>
      <div className="preview-stage">
        <img
          src={useThumbnail ? image.thumbnail : image.src}
          alt={result.title}
          referrerPolicy="no-referrer"
          onError={() => setUseThumbnail(true)}
        />
      </div>
      <h3 className="preview-title">{result.title}</h3>
      {facts && <p className="preview-facts">{facts}</p>}
      <div className="preview-actions">
        <a className="btn btn-primary" href={result.url} target="_blank" rel="noreferrer">
          访问 {hostOf(result.url)}
          <ExternalLinkIcon />
        </a>
        <a className="btn" href={image.src} target="_blank" rel="noreferrer">
          查看原图
        </a>
      </div>
    </aside>
  );
}
