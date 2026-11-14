import { useEffect, useId, useRef, useState } from 'react';
import { OptionsLink } from './OptionsLink';
import { t } from '../i18n';
import { CloseIcon, SlidersIcon } from '../lib/icons';
import { UiPreferencesPanel } from '../lib/UiPreferencesPanel';

export function QuickSettings() {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const onPointer = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); close(); } };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return <div ref={container} className="settings quick-settings" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="icon-btn" aria-label={t('ux.quick.title')} title={t('ux.quick.title')} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}><SlidersIcon /></button>
    {open && <section id={id} className="quick-settings-panel" role="dialog" aria-labelledby={`${id}-title`}>
      <header><h2 id={`${id}-title`}>{t('ux.quick.title')}</h2><button ref={closeButton} type="button" className="icon-btn" aria-label={t('ux.quick.close')} onClick={close}><CloseIcon /></button></header>
      <UiPreferencesPanel />
      <footer><OptionsLink>{t('ux.quick.all')}</OptionsLink><p>{t('ux.quick.keyboard')}</p></footer>
    </section>}
  </div>;
}
