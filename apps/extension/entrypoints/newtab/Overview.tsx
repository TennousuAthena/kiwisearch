import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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
        <a href={optionsUrl} target="_blank" rel="noreferrer">
          配置 LLM
        </a>
        后，这里会显示带引用的 AI 概览。
      </p>
    );
  }

  const folded = status === 'done' && tall && !expanded;
  return (
    <section className="overview" aria-labelledby="overview-title">
      <h2 id="overview-title" className="overview-title">
        <SparkleIcon />
        AI 概览
        {status === 'streaming' && <span className="spinner" aria-hidden="true" />}
      </h2>
      {status === 'loading' && (
        <>
          <p className="overview-note">正在读取前 {state.citations.length} 篇来源…</p>
          <div className="sk-lines" aria-hidden="true">
            {[100, 94, 98, 62].map((width, i) => (
              <div key={i} className="sk" style={{ width: `${width}%` }} />
            ))}
          </div>
        </>
      )}
      {status === 'starting' && <p className="overview-note">正在启动浏览器内置模型…</p>}
      {status === 'error' && (
        <div className="alert" role="alert">
          <CircleAlertIcon />
          <div className="alert-body">
            <p>{state.summaryError}</p>
            <a href={optionsUrl} target="_blank" rel="noreferrer">
              前往设置
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
          {expanded ? '收起' : '展开'}
          <ChevronDownIcon className={expanded ? 'flip' : ''} />
        </button>
      )}
    </section>
  );
}
