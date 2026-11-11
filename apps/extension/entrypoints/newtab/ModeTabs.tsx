import type { SearchMode } from '@kiwi-search/core';
import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon } from '@/lib/icons';
import { COMMUNITY_MODES, MODES, MODE_LABELS, isCommunityMode } from '@/lib/results';

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
    <nav className="tabs" aria-label="搜索类型">
      {MODES.filter((id) => !isCommunityMode(id)).map((id) => (
        <button key={id} type="button" className="tab" aria-current={id === mode ? 'page' : undefined} onClick={() => onChange(id)}>
          {MODE_LABELS[id]}
        </button>
      ))}
      <span className="tab-wrap" ref={wrap}>
        <button type="button" className="tab" aria-current={inCommunity ? 'page' : undefined} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
          {inCommunity ? `社区 · ${MODE_LABELS[mode]}` : '社区'}
          <ChevronDownIcon className="tab-caret" />
        </button>
        {open && (
          <div className="tab-menu" role="group" aria-label="社区平台">
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
                {MODE_LABELS[id]}
              </button>
            ))}
          </div>
        )}
      </span>
    </nav>
  );
}
