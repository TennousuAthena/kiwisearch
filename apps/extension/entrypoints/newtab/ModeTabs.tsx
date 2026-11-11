import type { SearchMode } from '@kiwi-search/core';
import { MODES, MODE_LABELS } from '@/lib/results';

interface Props {
  mode: SearchMode;
  onChange: (mode: SearchMode) => void;
}

export function ModeTabs({ mode, onChange }: Props) {
  return (
    <nav className="tabs" aria-label="搜索类型">
      {MODES.map((id) => (
        <button key={id} type="button" className="tab" aria-current={id === mode ? 'page' : undefined} onClick={() => onChange(id)}>
          {MODE_LABELS[id]}
        </button>
      ))}
    </nav>
  );
}
