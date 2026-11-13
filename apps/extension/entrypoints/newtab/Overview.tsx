import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { tr } from '@/lib/i18n/rich';
import { ChevronDownIcon, CircleAlertIcon, CopyIcon, SparkleIcon } from '@/lib/icons';
import { renderSummary } from '@/lib/markdown';
import { summaryCopyText } from '@/lib/resultUx';
import type { SearchState } from '@/lib/searchState';
import { ResultPopover } from './ResultPopover';
import './resultUx.css';

interface Props {
  state: SearchState;
  /** The portion left after a quick answer, when one was extracted. */
  text?: string;
  summaryMarkdown?: string;
  hide?: boolean;
  /** Action row for a promoted quick answer, without rendering its text a second time. */
  controlsOnly?: boolean;
  optionsUrl: string;
  onHoverCite: (n: number | null) => void;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  summaryMode?: 'auto' | 'on-demand' | 'off';
  onGenerate?: () => void;
  onStop?: () => void;
  onRetry?: () => void;
}

/** The same bounded viewport is present from loading onward, including partial and stopped answers. */
export function Overview({ state, text, summaryMarkdown, hide, controlsOnly = false, optionsUrl, onHoverCite, expanded: controlledExpanded,
  onExpandedChange, summaryMode = 'auto', onGenerate, onStop, onRetry }: Props) {
  const id = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [localExpanded, setLocalExpanded] = useState(false);
  const [tall, setTall] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'done' | 'error'>('idle');
  const expanded = controlledExpanded ?? localExpanded;
  const setExpanded = (value: boolean) => { if (controlledExpanded === undefined) setLocalExpanded(value); onExpandedChange?.(value); };
  const markdown = summaryMarkdown ?? text ?? state.summary;
  const html = useMemo(() => markdown ? renderSummary(markdown, state.citations) : '', [markdown, state.citations]);
  const status = state.summaryStatus;
  const busy = status === 'loading' || status === 'starting' || status === 'streaming';
  const citations = state.citations.filter((citation) => { try { return /^https?:$/.test(new URL(citation.url).protocol); } catch { return false; } });
  const canGenerate = state.stage === 'done' && state.results.some((result) => !result.hidden);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const viewport = viewportRef.current;
    if (!body || !viewport) return;
    const measure = () => setTall(body.scrollHeight > viewport.clientHeight + 1);
    if (!expanded) measure();
    const observer = new ResizeObserver(() => { if (!expanded) measure(); });
    observer.observe(body); observer.observe(viewport);
    return () => observer.disconnect();
  }, [html, busy, expanded]);

  if (hide) return null;
  if (summaryMode === 'off') return <p className="overview-hint">{t('resultUx.overview.off')}</p>;
  if (status === 'idle') {
    if (!canGenerate) return null;
    if (onGenerate) return <section className="overview overview-ux" aria-label={t('newtab.overview.title')}>
      <p className="overview-note">{t('resultUx.overview.onDemand')}</p>
      <button type="button" className="result-ux-button" onClick={onGenerate}><SparkleIcon />{t('resultUx.overview.generate')}</button>
    </section>;
    return <p className="overview-hint">{tr('newtab.overview.configureHint', { tags: { link: (label) => <a href={optionsUrl} target="_blank" rel="noreferrer">{label}</a> } })}</p>;
  }

  const highlight = (target: EventTarget) => {
    const n = (target as HTMLElement).closest('a.cite')?.getAttribute('data-n');
    onHoverCite(n ? Number(n) : null);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(summaryCopyText(state.summary || markdown, citations, t('resultUx.overview.sourceList'))); setCopyStatus('done'); }
    catch { setCopyStatus('error'); }
  };

  return (
    <section className={`overview overview-ux${controlsOnly ? ' overview-tools-only' : ''}`} aria-labelledby={controlsOnly ? undefined : `${id}-title`} aria-label={controlsOnly ? t('newtab.overview.title') : undefined}>
      {!controlsOnly && <h2 id={`${id}-title`} className="overview-title"><SparkleIcon />{t('newtab.overview.title')}{busy && <span className="spinner" aria-hidden="true" />}</h2>}
      {!controlsOnly && <div ref={viewportRef} id={`${id}-body`} className={`overview-viewport${busy ? ' busy' : ''}${expanded ? ' expanded' : ''}`}>
        {status === 'loading' && !html && <>
          <p className="overview-note">{t('newtab.overview.loading', { count: state.citations.length })}</p>
          <div className="sk-lines" aria-hidden="true">{[100, 94, 98, 62].map((width, i) => <div key={i} className="sk" style={{ width: `${width}%` }} />)}</div>
        </>}
        {status === 'starting' && !html && <p className="overview-note">{t('newtab.overview.starting')}</p>}
        {html && <div ref={bodyRef} className={status === 'streaming' ? 'md streaming' : 'md'}
          onMouseOver={(event) => highlight(event.target)} onMouseOut={() => onHoverCite(null)}
          onFocus={(event) => highlight(event.target)} onBlur={() => onHoverCite(null)}
          dangerouslySetInnerHTML={{ __html: html }} />}
      </div>}
      {status === 'stopped' && <p className="overview-status" role="status">{t(html ? 'resultUx.overview.stopped' : 'resultUx.overview.stoppedEmpty')}</p>}
      {status === 'error' && <div className="alert overview-error" role="alert"><CircleAlertIcon /><div className="alert-body">
        <p>{state.summaryError}</p><a href={optionsUrl} target="_blank" rel="noreferrer">{t('newtab.overview.openSettings')}</a>
      </div></div>}
      <div className="overview-controls">
        {!controlsOnly && (busy || tall || expanded) && <button type="button" className="result-ux-button overview-toggle" aria-controls={`${id}-body`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {t(expanded ? 'newtab.overview.collapse' : 'newtab.overview.expand')}<ChevronDownIcon className={expanded ? 'flip' : ''} />
        </button>}
        {busy && onStop && <button type="button" className="result-ux-button" onClick={onStop}>{t('resultUx.overview.stop')}</button>}
        {!busy && (onRetry || onGenerate) && <button type="button" className="result-ux-button" onClick={onRetry ?? onGenerate}>{t('resultUx.overview.retry')}</button>}
        {html && <button type="button" className="result-ux-button" onClick={() => void copy()}><CopyIcon />{t('resultUx.overview.copy')}</button>}
        {!!citations.length && <ResultPopover label={t('resultUx.overview.sources')} trigger={t('resultUx.overview.sources')}>
          {() => <>
            <p className="result-ux-popover-title">{t('resultUx.overview.sourceList')}</p>
            <ol className="overview-citation-list">{citations.map((citation) => <li key={citation.n}>
              <a data-result-link href={citation.url} target="_blank" rel="noreferrer" aria-label={t('resultUx.overview.source', { number: citation.n, title: citation.title })}
                onMouseEnter={() => onHoverCite(citation.n)} onMouseLeave={() => onHoverCite(null)} onFocus={() => onHoverCite(citation.n)} onBlur={() => onHoverCite(null)}>
                [{citation.n}] {citation.title}<small>{new URL(citation.url).hostname}</small>
              </a>
            </li>)}</ol>
          </>}
        </ResultPopover>}
        <span className="overview-copy-status" role="status">{copyStatus === 'done' ? t('resultUx.overview.copied') : copyStatus === 'error' ? t('resultUx.overview.copyFailed') : ''}</span>
      </div>
    </section>
  );
}
