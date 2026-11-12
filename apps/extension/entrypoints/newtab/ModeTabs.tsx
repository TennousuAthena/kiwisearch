import type { SearchMode } from '@kiwi-search/core';
import { useEffect, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { ChevronDownIcon } from '@/lib/icons';
import { COMMUNITY_MODES, MODES, isCommunityMode, modeLabel } from '@/lib/results';

interface Props {
  mode: SearchMode;
  onChange: (mode: SearchMode) => void;
}

/** 全部 / 图片 / 视频 / 学术, and the platforms (知乎, 小红书, 公众号, X) folded under one "社区" tab so the row stays short. */
export function ModeTabs({ mode, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const inCommunity = isCommunityMode(mode);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !wrap.current?.contains(event.target as Node)) setOpen(false);
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
          {modeLabel(id)}
        </button>
      ))}
      <span className="tab-wrap" ref={wrap}>
        <button type="button" className="tab" aria-current={inCommunity ? 'page' : undefined} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
          {inCommunity ? t('newtab.tabs.communityMode', { mode: modeLabel(mode) }) : t('newtab.tabs.community')}
          <ChevronDownIcon className="tab-caret" />
        </button>
        {open && (
          <div className="tab-menu" role="group" aria-label={t('newtab.tabs.communityMenuLabel')}>
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
                {modeLabel(id)}
              </button>
            ))}
          </div>
        )}
      </span>
    </nav>
  );
}
