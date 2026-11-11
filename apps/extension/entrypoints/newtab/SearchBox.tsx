import { useEffect, useRef } from 'react';
import { CloseIcon, SearchIcon } from '@/lib/icons';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

export function SearchBox({ value, onChange, onSubmit }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  // "/" jumps to the box from anywhere on the page, as on Google.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]')) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <form
      className="searchbox"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <SearchIcon className="searchbox-icon" />
      <input
        ref={inputRef}
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label="搜索"
        autoComplete="off"
        enterKeyHint="search"
        spellCheck={false}
      />
      {value && (
        <button
          type="button"
          className="searchbox-btn"
          aria-label="清除"
          onClick={() => {
            onChange('');
            inputRef.current?.focus();
          }}
        >
          <CloseIcon />
        </button>
      )}
      <button type="submit" className="searchbox-btn searchbox-submit" aria-label="搜索">
        <SearchIcon />
      </button>
    </form>
  );
}
