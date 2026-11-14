import type { SearchMode } from '@kiwi-search/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { ChevronDownIcon } from '../lib/icons';
import { ModeIcon } from '../lib/modeIcons';
import { COMMUNITY_MODES, MODES, isCommunityMode, modeLabel } from '../lib/results';

interface Props {
  mode: SearchMode;
  onChange: (mode: SearchMode) => void;
}

/** Main search modes, with community platforms folded under one tab. */
export function ModeTabs({ mode, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const inCommunity = isCommunityMode(mode);

  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const place = () => {
      const element = menu.current;
      if (!element) return;
      element.style.transform = '';
      const bounds = element.getBoundingClientRect();
      // The trigger can wrap onto either edge of a narrow row.
      const offset = Math.max(8 - bounds.left, Math.min(0, window.innerWidth - 8 - bounds.right));
      element.style.transform = `translateX(${offset}px)`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !wrap.current?.contains(event.target as Node)) {
        setOpen(false);
        if (event instanceof KeyboardEvent) wrap.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  return (
    <nav className="tabs" aria-label={t('newtab.tabs.label')}>
      {MODES.filter((id) => !isCommunityMode(id)).map((id) => (
        <button key={id} type="button" className="tab" aria-current={id === mode ? 'page' : undefined} onClick={() => onChange(id)}>
          <ModeIcon mode={id} className="mode-icon" />
          <span>{modeLabel(id)}</span>
        </button>
      ))}
      <span className="tab-wrap" ref={wrap}>
        <button type="button" className="tab" aria-current={inCommunity ? 'page' : undefined} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ModeIcon mode="community" className="mode-icon" />
          <span>{inCommunity ? t('newtab.tabs.communityMode', { mode: modeLabel(mode) }) : t('newtab.tabs.community')}</span>
          <ChevronDownIcon className="tab-caret" />
        </button>
        {open && (
          <div className="tab-menu" ref={menu} role="group" aria-label={t('newtab.tabs.communityMenuLabel')}>
            {COMMUNITY_MODES.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={id === mode}
                onClick={() => {
                  setOpen(false);
                  onChange(id);
                }}
              >
                <ModeIcon mode={id} className="mode-icon" />
                <span>{modeLabel(id)}</span>
              </button>
            ))}
          </div>
        )}
      </span>
    </nav>
  );
}
