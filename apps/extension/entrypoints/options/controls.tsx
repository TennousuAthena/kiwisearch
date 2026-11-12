import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CloseIcon } from '@/lib/icons';
import { addDomains } from '@/lib/domains';
import { t } from '@/lib/i18n';

/** An on/off switch. Used instead of a checkbox where the change takes effect at once. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  );
}

/** A switch with its words beside it; the words toggle it too. */
export function SwitchRow({ checked, onChange, title, hint, disabled }: { checked: boolean; onChange: (next: boolean) => void; title: string; hint?: ReactNode; disabled?: boolean }) {
  return (
    <div className={disabled ? 'switch-row disabled' : 'switch-row'}>
      <Switch checked={checked} onChange={onChange} label={title} disabled={disabled} />
      <div>
        <strong>{title}</strong>
        {hint && <p>{hint}</p>}
      </div>
    </div>
  );
}

/** A few exclusive choices side by side, for a setting that changes what the controls under it are. */
export function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (next: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} className="seg" onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, wide, children }: { label: string; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <label className={wide ? 'field field-wide' : 'field'}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/**
 * A number the user types. A value outside the range, or half a number, never reaches the settings (autosave would store
 * it); leaving the field puts the last good value back.
 */
export function NumberField({ label, hint, value, min, max, step, onChange }: { label: string; hint?: ReactNode; value: number; min: number; max?: number; step?: number; onChange: (next: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          setText(event.target.value);
          const next = Number(event.target.value);
          if (event.target.value.trim() !== '' && Number.isFinite(next) && next >= min && (max === undefined || next <= max)) onChange(next);
        }}
        onBlur={() => setText(String(value))}
      />
    </Field>
  );
}

/** A key or token: hidden by default, with a button to look at what was typed. */
export function SecretInput({ value, onChange, placeholder, label }: { value: string; onChange: (next: string) => void; placeholder?: string; label: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="secret">
      <input type={shown ? 'text' : 'password'} aria-label={label} value={value} placeholder={placeholder} autoComplete="off" spellCheck={false} onChange={(event) => onChange(event.target.value)} />
      <button type="button" className="secret-toggle" aria-pressed={shown} onClick={() => setShown(!shown)}>
        {shown ? t('options.controls.hide') : t('options.controls.show')}
      </button>
    </span>
  );
}

/** A list of host names as removable tags. Enter, comma or space adds; a pasted list is split; "https://www.a.com/x" becomes "a.com". */
export function DomainInput({ label, values, onChange, placeholder }: { label: string; values: string[]; onChange: (next: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  function commit(text: string) {
    if (!text.trim()) return;
    const { list, rejected } = addDomains(values, text);
    if (list.length !== values.length) onChange(list);
    setDraft(rejected.join(' '));
    setProblem(rejected.length ? t('options.controls.notDomain', { domains: rejected.join(t('options.listSeparator')) }) : '');
  }
  return (
    <div className="tags-field">
      <span className="tags-label" id={`tags-${label}`}>
        {label}
      </span>
      <div className="tags" onClick={(event) => (event.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
        {values.map((value) => (
          <span className="tag-chip" key={value}>
            {value}
            <button type="button" aria-label={t('options.controls.removeDomain', { domain: value })} onClick={() => onChange(values.filter((v) => v !== value))}>
              <CloseIcon />
            </button>
          </span>
        ))}
        <input
          aria-labelledby={`tags-${label}`}
          value={draft}
          placeholder={values.length ? '' : placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (['Enter', ',', ' ', '，'].includes(event.key) && draft.trim()) { // i18n-ignore (data, not interface text)
              event.preventDefault();
              commit(draft);
            } else if (event.key === 'Backspace' && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            commit(draft + ' ' + event.clipboardData.getData('text'));
          }}
          onBlur={() => commit(draft)}
        />
      </div>
      {problem && (
        <small role="alert" className="problem">
          {problem}
        </small>
      )}
    </div>
  );
}

/** A list of short sentences (the user's own filter rules), one per row, added with Enter. */
export function RuleList({ label, values, onChange, placeholder }: { label: string; values: string[]; onChange: (next: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  function add() {
    const text = draft.trim();
    if (text && !values.includes(text)) onChange([...values, text]);
    setDraft('');
  }
  return (
    <div className="rules">
      <span className="tags-label">{label}</span>
      {values.length > 0 && (
        <ul>
          {values.map((value) => (
            <li key={value}>
              <span>{value}</span>
              <button type="button" aria-label={t('options.controls.deleteRule', { rule: value })} onClick={() => onChange(values.filter((v) => v !== value))}>
                <CloseIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="rules-add">
        <input
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn" disabled={!draft.trim()} onClick={add}>
          {t('options.controls.add')}
        </button>
      </div>
    </div>
  );
}

/** A modal "are you sure?". Escape, a click on the backdrop and the cancel button all close it without confirming; focus starts on cancel. */
export function ConfirmDialog({ title, confirmLabel, onConfirm, onCancel, children }: { title: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="confirm" aria-labelledby="confirm-title" onClose={onCancel} onClick={(event) => event.target === ref.current && ref.current.close()}>
      <div className="confirm-body">
        <h2 id="confirm-title">{title}</h2>
        <p>{children}</p>
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>
            {t('options.controls.cancel')}
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
