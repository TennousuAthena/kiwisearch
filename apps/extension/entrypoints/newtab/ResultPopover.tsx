import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t } from '@/lib/i18n';
import { CloseIcon } from '@/lib/icons';
import './resultUx.css';

/** A nonmodal, viewport-clamped popover shared by result and source controls. */
export function ResultPopover({ label, trigger, triggerClass, children }: {
  label: string;
  trigger: ReactNode;
  triggerClass?: string;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const close = () => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - panel.width - 8));
      const top = anchor.bottom + 6 + panel.height <= window.innerHeight - 8
        ? anchor.bottom + 6 : Math.max(8, anchor.top - panel.height - 6);
      setPosition({ left, top });
    };
    place();
    panelRef.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key, true); };
  }, [open]);

  return (
    <>
      <button ref={triggerRef} type="button" className={triggerClass ?? 'result-ux-button'} aria-label={label}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        {trigger}
      </button>
      {open && createPortal(
        <div ref={panelRef} id={id} className="result-ux-popover" role="dialog" aria-label={label} tabIndex={-1} style={position}
          onBlur={(event) => {
            if ((!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) && event.relatedTarget !== triggerRef.current) setOpen(false);
          }}>
          <button type="button" className="icon-btn result-ux-close" aria-label={t('resultUx.close')} onClick={close}><CloseIcon /></button>
          {children(close)}
        </div>, document.body,
      )}
    </>
  );
}
