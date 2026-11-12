import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { t } from '@/lib/i18n';
import { tr } from '@/lib/i18n/rich';
import { ChevronDownIcon, CircleAlertIcon, SparkleIcon } from '@/lib/icons';
import { renderSummary } from '@/lib/markdown';
import type { SearchState } from '@/lib/searchState';

/** About six lines of summary text; a finished overview taller than this folds. */
const COLLAPSED_PX = 150;

interface Props {
  state: SearchState;
  optionsUrl: string;
  onHoverCite: (n: number | null) => void;
}

/** The AI overview, above the results or in a column beside them. Mount with a key per search so folding resets. */
export function Overview({ state, optionsUrl, onHoverCite }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [tall, setTall] = useState(false);
  const html = useMemo(() => (state.summary ? renderSummary(state.summary, state.citations) : ''), [state.summary, state.citations]);
  const { summaryStatus: status } = state;

  // Fold only once the text is complete, so it doesn't jump while it is being written.
  useLayoutEffect(() => {
    if (status === 'done' && bodyRef.current) setTall(bodyRef.current.scrollHeight > COLLAPSED_PX + 24);
  }, [html, status]);

  if (status === 'idle') {
    if (state.stage !== 'done' || !state.results.length) return null;
    return (
      <p className="overview-hint">
        {tr('newtab.overview.configureHint', {
          tags: {
            link: (text) => (
              <a href={optionsUrl} target="_blank" rel="noreferrer">
                {text}
              </a>
            ),
          },
        })}
      </p>
    );
  }

  const folded = status === 'done' && tall && !expanded;
  return (
    <section className="overview" aria-labelledby="overview-title">
      <h2 id="overview-title" className="overview-title">
        <SparkleIcon />
        {t('newtab.overview.title')}
        {status === 'streaming' && <span className="spinner" aria-hidden="true" />}
      </h2>
      {status === 'loading' && (
        <>
          <p className="overview-note">{t('newtab.overview.loading', { count: state.citations.length })}</p>
          <div className="sk-lines" aria-hidden="true">
            {[100, 94, 98, 62].map((width, i) => (
              <div key={i} className="sk" style={{ width: `${width}%` }} />
            ))}
          </div>
        </>
      )}
      {status === 'starting' && <p className="overview-note">{t('newtab.overview.starting')}</p>}
      {status === 'error' && (
        <div className="alert" role="alert">
          <CircleAlertIcon />
          <div className="alert-body">
            <p>{state.summaryError}</p>
            <a href={optionsUrl} target="_blank" rel="noreferrer">
              {t('newtab.overview.openSettings')}
            </a>
          </div>
        </div>
      )}
      {html && (
        <div className={folded ? 'overview-body folded' : 'overview-body'} style={folded ? ({ '--fold': `${COLLAPSED_PX}px` } as CSSProperties) : undefined}>
          <div
            ref={bodyRef}
            className={status === 'streaming' ? 'md streaming' : 'md'}
            onMouseOver={(event) => {
              const n = (event.target as HTMLElement).closest('a.cite')?.getAttribute('data-n');
              onHoverCite(n ? Number(n) : null);
            }}
            onMouseOut={() => onHoverCite(null)}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
      {status === 'done' && tall && (
        <button type="button" className="disclosure overview-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? t('newtab.overview.collapse') : t('newtab.overview.expand')}
          <ChevronDownIcon className={expanded ? 'flip' : ''} />
        </button>
      )}
    </section>
  );
}
