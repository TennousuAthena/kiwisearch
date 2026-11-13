import { useEffect, useId, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { CloseIcon, SearchIcon } from '@/lib/icons';
import { suggestQueries } from '@/lib/searchHistory';

interface Props {
  value: string;
  resetToken?: string;
  onChange: (value: string) => void;
  onSubmit: (query?: string) => void;
  recentQueries?: string[];
  onClearRecent?: () => void;
}

export function SearchBox({ value, resetToken, onChange, onSubmit, recentQueries = [], onClearRecent }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [active, setActive] = useState(-1);
  const suggestions = suggestQueries(recentQueries, draft);
  const expanded = open && suggestions.length > 0;
  useEffect(() => { setOpen(false); setActive(-1); setDraft(value); composing.current = false; }, [resetToken]);
  const submit = (query = value) => { setOpen(false); setActive(-1); onChange(query); onSubmit(query); };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]')) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return <form className={`searchbox${expanded ? ' has-suggestions' : ''}`} role="search"
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setActive(-1); } }}
    onSubmit={(event) => { event.preventDefault(); if (!composing.current) submit(); }}>
    <SearchIcon className="searchbox-icon" />
    <input ref={inputRef} autoFocus value={value} role="combobox" aria-autocomplete="list"
      aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
      aria-label={t('newtab.searchbox.label')} autoComplete="off" enterKeyHint="search" spellCheck={false}
      onFocus={() => { setDraft(value); setOpen(true); setActive(-1); }}
      onChange={(event) => { onChange(event.target.value); setDraft(event.target.value); setActive(-1); setOpen(true); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={(event) => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === 'Enter') event.preventDefault();
          return;
        }
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length) {
          event.preventDefault(); setOpen(true);
          const next = event.key === 'ArrowDown' ? (active + 1) % suggestions.length : (active <= 0 ? suggestions.length - 1 : active - 1);
          setActive(next); onChange(suggestions[next]);
        } else if (event.key === 'Escape') {
          if (open) { event.preventDefault(); event.stopPropagation(); if (active >= 0) onChange(draft); setOpen(false); setActive(-1); }
        } else if (event.key === 'Enter' && expanded && active >= 0) {
          event.preventDefault(); submit(suggestions[active]);
        }
      }} />
    {value && <button type="button" className="searchbox-btn" aria-label={t('newtab.searchbox.clear')}
      onClick={() => { onChange(''); setDraft(''); setActive(-1); inputRef.current?.focus(); setOpen(true); }}><CloseIcon /></button>}
    <button type="submit" className="searchbox-btn searchbox-submit" aria-label={t('newtab.searchbox.submit')}><SearchIcon /></button>
    {expanded && <div className="search-suggestions">
      <div className="suggestions-caption"><span>{t('ux.search.recent')}</span><span>{t('ux.search.localOnly')}</span></div>
      <ul id={listId} role="listbox" aria-label={t('ux.search.suggestions')}>
        {suggestions.map((query, index) => <li key={query} id={`${listId}-${index}`} role="option" aria-selected={index === active}
          onPointerDown={(event) => event.preventDefault()} onClick={() => submit(query)}><SearchIcon /><span>{query}</span></li>)}
      </ul>
      {onClearRecent && <button type="button" className="clear-recent" onClick={() => { onClearRecent(); setOpen(false); inputRef.current?.focus(); }}>{t('ux.search.clearRecent')}</button>}
    </div>}
    <span className="sr-only" role="status">{expanded ? t('ux.search.suggestionCount', { count: suggestions.length }) : ''}</span>
  </form>;
}
