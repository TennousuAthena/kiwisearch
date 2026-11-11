import type { SearchMode } from '@kiwi-search/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { SlidersIcon } from '@/lib/icons';
import { MODE_LABELS, filterSince, modeHasOverview, parseMode, searchUrl, sinceYears, sortPapers, splitResults, type PaperSort } from '@/lib/results';
import { useSearchSession } from '@/lib/useSearchSession';
import { ImageResults } from './ImageResults';
import { ModeTabs } from './ModeTabs';
import { NoteResults } from './NoteResults';
import { Overview } from './Overview';
import { HiddenResults, ResultList } from './Results';
import { SearchBox } from './SearchBox';
import { EmptyState, FatalError, ListSkeleton, StatusLine } from './Status';

type History = 'push' | 'replace' | 'none';

function initialFromUrl() {
  const params = new URLSearchParams(location.search);
  return { query: params.get('q') ?? '', mode: parseMode(params.get('m')) };
}

export default function App() {
  const initial = useMemo(initialFromUrl, []);
  const [input, setInput] = useState(initial.query);
  const [mode, setMode] = useState<SearchMode>(initial.mode);
  const [hoverCite, setHoverCite] = useState<number | null>(null);
  const [since, setSince] = useState<number | undefined>();
  const [sort, setSort] = useState<PaperSort>('relevance');
  const { state, search, reset } = useSearchSession();
  const optionsUrl = browser.runtime.getURL('/options.html');

  const go = useCallback(
    (query: string, nextMode: SearchMode, history: History) => {
      const q = query.trim();
      if (!q) return;
      setInput(q);
      setMode(nextMode);
      setHoverCite(null);
      setSince(undefined);
      setSort('relevance');
      document.title = `${q} - Kiwi Search`;
      if (history !== 'none') {
        const url = searchUrl(location.href, q, nextMode);
        // A new search is a history entry, so Back returns to the previous query.
        if (history === 'push' && url !== location.href) window.history.pushState(null, '', url);
        else window.history.replaceState(null, '', url);
      }
      search(q, nextMode);
    },
    [search],
  );

  useEffect(() => {
    if (initial.query) go(initial.query, initial.mode, 'replace');
  }, [go, initial]);

  useEffect(() => {
    const onPopState = () => {
      const { query, mode: nextMode } = initialFromUrl();
      if (query) {
        go(query, nextMode, 'none');
      } else {
        reset();
        setInput('');
        setMode(nextMode);
        document.title = 'Kiwi Search';
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [go, reset]);

  const changeMode = (next: SearchMode) => {
    if (next === mode) return;
    if (state) go(state.query, next, 'push');
    else setMode(next);
  };

  const idle = !state;
  const { visible, hidden } = useMemo(() => splitResults(state?.results ?? []), [state?.results]);
  const citedUrls = useMemo(() => new Map(state?.citations.map((c) => [c.url, c.n]) ?? []), [state?.citations]);
  const papers = useMemo(() => sortPapers(filterSince(visible, since), sort), [visible, since, sort]);
  const years = useMemo(() => sinceYears(), []);

  const shown = state?.mode === 'academic' ? papers : visible;
  const searching = !!state && (state.stage !== 'done' || state.running.length > 0) && !state.fatal;
  const liveStatus = !state
    ? ''
    : state.fatal
      ? `搜索失败：${state.fatal}`
      : state.stage === 'done'
        ? `${MODE_LABELS[state.mode]}：共 ${visible.length} 条结果`
        : '正在搜索';

  return (
    <div className={`page${idle ? ' idle' : ''}${state ? ` mode-${state.mode}` : ''}`}>
      {searching && <div className="progress" aria-hidden="true" />}
      <header className="topbar">
        <h1 className="brand">
          <a href={browser.runtime.getURL('/newtab.html')}>Kiwi</a>
        </h1>
        <SearchBox value={input} onChange={setInput} onSubmit={() => go(input, mode, 'push')} />
        <a className="icon-btn settings" href={optionsUrl} target="_blank" rel="noreferrer" title="设置" aria-label="设置">
          <SlidersIcon />
        </a>
      </header>
      <ModeTabs mode={mode} onChange={changeMode} />
      <p className="sr-only" role="status">
        {liveStatus}
      </p>

      {state && (
        <main className="content" aria-busy={state.stage !== 'done'}>
          <StatusLine
            state={state}
            visibleCount={shown.length}
            onOpenWorker={(source) => void browser.runtime.sendMessage({ type: 'kiwi:focus-worker', source })}
          />
          {state.fatal && <FatalError message={state.fatal} onRetry={() => go(state.query, state.mode, 'replace')} />}

          {/* The overview comes first in the DOM: above the results when the page is narrow, in a column to their right when there is room (see .body in style.css). */}
          <div className={modeHasOverview(state.mode) ? 'body with-rail' : 'body'}>
            {modeHasOverview(state.mode) && (
              <div className="rail">
                <Overview key={`${state.query}|${state.mode}|${state.startedAt}`} state={state} optionsUrl={optionsUrl} onHoverCite={setHoverCite} />
              </div>
            )}
            <div className="results">
              {state.mode === 'academic' && visible.length > 0 && (
                <div className="toolbar" role="group" aria-label="筛选">
                  <div className="chips">
                    <button type="button" className="chip" aria-pressed={since === undefined} onClick={() => setSince(undefined)}>
                      不限时间
                    </button>
                    {years.map((year) => (
                      <button key={year} type="button" className="chip" aria-pressed={since === year} onClick={() => setSince(year)}>
                        {year} 年以来
                      </button>
                    ))}
                  </div>
                  <button type="button" className="chip" aria-pressed={sort === 'citations'} onClick={() => setSort(sort === 'citations' ? 'relevance' : 'citations')}>
                    按被引次数排序
                  </button>
                </div>
              )}

              {shown.length === 0 && state.stage === 'searching' && !state.fatal && <ListSkeleton mode={state.mode} />}
              {shown.length === 0 && state.stage !== 'searching' && !state.fatal && (
                <EmptyState mode={state.mode} waitingForVerification={state.blocked.length > 0} optionsUrl={optionsUrl} />
              )}
              {shown.length > 0 &&
                (state.mode === 'images' ? (
                  <ImageResults results={shown} />
                ) : state.mode === 'xiaohongshu' ? (
                  <NoteResults results={shown} />
                ) : (
                  <ResultList results={shown} mode={state.mode} hoverCite={hoverCite} citedUrls={citedUrls} />
                ))}
              {state.mode !== 'images' && <HiddenResults results={hidden} mode={state.mode} />}
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
