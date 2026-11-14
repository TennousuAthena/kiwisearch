import type { FusedResult } from '@kiwi-search/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from 'react';
import { ArrowLeftIcon, ArrowRightIcon, CloseIcon, ExternalLinkIcon } from '../lib/icons';
import { t } from '../i18n';
import { justifiedRows } from '../lib/justify';
import { hostOf } from '../lib/results';
import './resultUx.css';

const GAP = 8;
const target = (width: number) => (width < 520 ? 120 : width < 900 ? 160 : 200);
const ratioOf = (result: FusedResult) => {
  const { width, height } = result.image ?? {};
  return width && height ? width / height : NaN;
};

const imageUrl = (result: FusedResult) => result.image?.src ?? result.url;

export function ImageResults({ results, selectedUrl: controlledUrl, onSelectedChange }: {
  results: FusedResult[];
  selectedUrl?: string | null;
  onSelectedChange?: (url: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const tilesRef = useRef(new Map<string, HTMLButtonElement>());
  const moveFocus = useRef(false);
  const [width, setWidth] = useState(0);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const selectedUrl = controlledUrl === undefined ? localUrl : controlledUrl;
  const setSelectedUrl = useCallback((url: string | null) => {
    if (controlledUrl === undefined) setLocalUrl(url);
    onSelectedChange?.(url);
  }, [controlledUrl, onSelectedChange]);
  const [broken, setBroken] = useState<Set<string>>(() => new Set());

  // Thumbnails that fail to load drop out of the layout instead of leaving holes.
  const shown = useMemo(() => results.filter((r) => r.image && !broken.has(r.key)), [results, broken]);
  const rows = useMemo(() => justifiedRows(shown.map(ratioOf), width, target(width), GAP), [shown, width]);
  const selectedIndex = shown.findIndex((r) => imageUrl(r) === selectedUrl || r.url === selectedUrl);
  const selected = selectedIndex >= 0 ? shown[selectedIndex] : null;
  const hadSelection = useRef(false);
  const close = useCallback(() => {
    const returnTo = selected ? tilesRef.current.get(imageUrl(selected)) : undefined;
    setSelectedUrl(null);
    requestAnimationFrame(() => (returnTo ?? gridRef.current)?.focus({ preventScroll: true }));
  }, [selected, setSelectedUrl]);

  useLayoutEffect(() => {
    if (selected && moveFocus.current) { closeRef.current?.focus({ preventScroll: true }); moveFocus.current = false; }
    if (hadSelection.current && !selected && selectedUrl) close();
    hadSelection.current = !!selected;
  }, [selected, selectedUrl, close]);

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
      const target = event.target as Element | null;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        !containerRef.current?.contains(target) || target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"]')) return;
      if (event.key === 'Escape') close();
      else if (event.key === 'ArrowRight' && selectedIndex < shown.length - 1) setSelectedUrl(imageUrl(shown[selectedIndex + 1]));
      else if (event.key === 'ArrowLeft' && selectedIndex > 0) setSelectedUrl(imageUrl(shown[selectedIndex - 1]));
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, selectedIndex, shown, close, setSelectedUrl]);

  return (
    <div className={selected ? 'images with-preview' : 'images'} ref={containerRef}>
      <div className="image-grid" ref={gridRef} tabIndex={-1}>
        {rows.map((row) => (
          <div className="image-row" key={row.items[0].index} style={{ height: row.height }}>
            {row.items.map((item) => {
              const result = shown[item.index];
              return (
                <button
                  key={result.key}
                  ref={(node) => { if (node) tilesRef.current.set(imageUrl(result), node); else tilesRef.current.delete(imageUrl(result)); }}
                  type="button"
                  className="image-tile"
                  data-result-key={result.key}
                  aria-pressed={result === selected}
                  aria-label={result.title}
                  title={result.title}
                  style={{ width: item.width, height: item.height }}
                  onClick={() => { if (result === selected) close(); else { moveFocus.current = true; setSelectedUrl(imageUrl(result)); } }}
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
          result={selected}
          closeRef={closeRef}
          onClose={close}
          onPrevious={selectedIndex > 0 ? () => setSelectedUrl(imageUrl(shown[selectedIndex - 1])) : undefined}
          onNext={selectedIndex < shown.length - 1 ? () => setSelectedUrl(imageUrl(shown[selectedIndex + 1])) : undefined}
        />
      )}
    </div>
  );
}

function ImagePreview({
  result,
  closeRef,
  onClose,
  onPrevious,
  onNext,
}: {
  result: FusedResult;
  closeRef: Ref<HTMLButtonElement>;
  onClose: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const image = result.image!;
  // Many hosts block hot-linking; fall back to the thumbnail rather than a broken image.
  const [useThumbnail, setUseThumbnail] = useState(false);
  useEffect(() => setUseThumbnail(false), [image.src]);
  const size = image.width && image.height ? `${image.width} × ${image.height}` : '';
  const facts = [size, image.license, image.creator].filter(Boolean).join(' · ');
  return (
    <aside className="preview" aria-label={t('newtab.images.previewLabel')}>
      <div className="preview-bar">
        <button type="button" className="icon-btn" onClick={onPrevious} disabled={!onPrevious} aria-label={t('newtab.images.previous')}>
          <ArrowLeftIcon />
        </button>
        <button type="button" className="icon-btn" onClick={onNext} disabled={!onNext} aria-label={t('newtab.images.next')}>
          <ArrowRightIcon />
        </button>
        <button ref={closeRef} type="button" className="icon-btn preview-close" onClick={onClose} aria-label={t('newtab.images.close')}>
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
          {t('newtab.images.visit', { host: hostOf(result.url) })}
          <ExternalLinkIcon />
        </a>
        <a className="btn" href={image.src} target="_blank" rel="noreferrer">
          {t('newtab.images.original')}
        </a>
      </div>
    </aside>
  );
}
