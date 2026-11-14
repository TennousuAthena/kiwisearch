import type { NewsOptions, SearchMode } from '@kiwi-search/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { loadAcademicLanguage, saveAcademicLanguage, type AcademicLanguage } from '@/lib/academicLanguage';
import { t } from '@/lib/i18n';
import { CloseIcon } from '@/lib/icons';
import { updateDomainPreference, undoDomainPreference, type DomainPreferenceUndo } from '@/lib/configUpdates';
import { captureReadingPosition, createSnapshotCache, rememberQuery, restoreReadingPosition, type ReadingPosition } from '@/lib/searchHistory';
import { getUiPreferences, initializeUiPreferences, useUiPreferences } from '@/lib/uiPreferences';
import { summaryBusy, type SearchState } from '@/lib/searchState';
import { KiwiLogo } from '@/lib/KiwiLogo';
import { formatNewsDate, parseNewsOptions } from '@/lib/news';
import { extractQuickAnswer } from '@/lib/quickAnswer';
import { filterSince, hasCjk, modeHasOverview, modeLabel, parseMode, pickLandmarks, searchUrl, sinceYears, sortPapers, splitPlatforms, splitResults, type PaperSort } from '@/lib/results';
import { decideSuggestion, type SuggestionAction } from '@/lib/suggestion';
import { useSearchSession } from '@/lib/useSearchSession';
import { Landmarks, PlanLine } from './AcademicPlan';
import { ImageResults } from './ImageResults';
import { ModeTabs } from './ModeTabs';
import { NewsToolbar } from './NewsToolbar';
import { PlatformStrip } from './PlatformStrip';
import { NoteResults } from './NoteResults';
import { Overview } from './Overview';
import { QuickAnswer } from './QuickAnswer';
import { QuickSettings } from './QuickSettings';
import './frontendUx.css';
import { HiddenResults, ResultList } from './Results';
import { SearchBox } from './SearchBox';
import { EmptyState, FatalError, ListSkeleton, StatusLine, SuggestionLine } from './Status';

type History = 'push' | 'replace' | 'none';
type SiteFilter = { kind: 'only' | 'exclude'; domain: string } | null;
interface ViewSnapshot {
  historyExpired: boolean; state: SearchState | null; input: string; mode: SearchMode; newsOptions: NewsOptions;
  since?: number; sort: PaperSort; academicLanguage: AcademicLanguage;
  overviewExpanded: boolean; expandedSnippetKeys: string[]; hiddenExpanded: boolean; selectedImage: string | null; siteFilter: SiteFilter; position: ReadingPosition;
}
function initialFromUrl() {
  const params = new URLSearchParams(location.search);
  const year = Number(params.get('since'));
  return { query: params.get('q') ?? '', mode: parseMode(params.get('m')), news: parseNewsOptions(params),
    since: Number.isInteger(year) && year >= 1900 && year <= new Date().getFullYear() ? year : undefined,
    paperSort: params.get('paperSort') === 'citations' ? 'citations' as const : 'relevance' as const };
}
function entryUrl(query: string, mode: SearchMode, news: NewsOptions, since?: number, sort: PaperSort = 'relevance') {
  const url = new URL(searchUrl(location.href, query, mode, news));
  url.searchParams.delete('since'); url.searchParams.delete('paperSort');
  if (mode === 'academic') {
    if (since) url.searchParams.set('since', String(since));
    if (sort === 'citations') url.searchParams.set('paperSort', sort);
  }
  return url.href;
}
const domainMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const resultHost = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };

export default function App() {
  const initial = useMemo(initialFromUrl, []);
  const [input, setInput] = useState(initial.query);
  const [mode, setMode] = useState<SearchMode>(initial.mode);
  const [newsOptions, setNewsOptions] = useState<NewsOptions>(initial.news);
  const newsRef = useRef(initial.news);
  const [hoverCite, setHoverCite] = useState<number | null>(null);
  const [since, setSince] = useState<number | undefined>(initial.since);
  const [sort, setSort] = useState<PaperSort>(initial.paperSort);
  // The academic tab's language limit, remembered between visits. The ref is what a search reads, so `go` does not change with it.
  const [academicLanguage, setAcademicLanguage] = useState<AcademicLanguage>('any');
  const languageRef = useRef<AcademicLanguage>('any');
  const { state, search, reset, stop, restore, summarize, stopSummary } = useSearchSession();
  const { preferences } = useUiPreferences();
  const [recentQueries, setRecentQueries] = useState<string[]>([]);
  const [overviewExpanded, setOverviewExpanded] = useState(false);
  const [expandedSnippetKeys, setExpandedSnippetKeys] = useState<string[]>([]);
  const [hiddenExpanded, setHiddenExpanded] = useState(false);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [siteFilter, setSiteFilter] = useState<SiteFilter>(null);
  const [domainOverrides, setDomainOverrides] = useState<Record<string, 'block' | 'boost'>>({});
  const [notice, setNotice] = useState<{ text: string; undo?: DomainPreferenceUndo; previous?: 'block' | 'boost' } | null>(null);
  const [historyExpired, setHistoryExpired] = useState(false);
  const [restoreTick, setRestoreTick] = useState(0);
  const undoButton = useRef<HTMLButtonElement>(null);
  const navigationRevision = useRef(0);
  const snapshots = useRef(createSnapshotCache<ViewSnapshot>());
  const entryId = useRef<string>(window.history.state?.kiwiEntry ?? crypto.randomUUID());
  const reading = useRef<ReadingPosition>({ y: 0 });
  const pendingPosition = useRef<ReadingPosition | null>(null);
  const view = useRef<ViewSnapshot | null>(null);
  view.current = { historyExpired, state, input, mode, newsOptions, since, sort, academicLanguage, overviewExpanded, expandedSnippetKeys, hiddenExpanded, selectedImage, siteFilter, position: reading.current };
  const saveSnapshot = useCallback(() => {
    if (view.current) snapshots.current.put(entryId.current, { ...view.current, position: captureReadingPosition() });
  }, []);
  const writeEntry = useCallback((url: string, how: History) => {
    if (how === 'none') return;
    if (how === 'push' && url !== location.href) {
      entryId.current = crypto.randomUUID();
      window.history.pushState({ kiwiEntry: entryId.current }, '', url);
    } else window.history.replaceState({ ...window.history.state, kiwiEntry: entryId.current }, '', url);
  }, []);
  const optionsUrl = browser.runtime.getURL('/options.html');
  // A moved search: the page switched tabs by itself, and the line says so and offers the way back.
  const [moved, setMoved] = useState<{ query: string; mode: SearchMode } | null>(null);
  // Only a search the user typed (or the page was opened with) may move by itself, never a Back or a reload.
  const autoAllowed = useRef(false);
  const declinedQuery = useRef<string | null>(null);

  const go = useCallback(
    (query: string, nextMode: SearchMode, history: History, opts: { auto?: boolean; typed?: boolean; news?: NewsOptions; refresh?: boolean; since?: number; sort?: PaperSort; summarize?: boolean } = {}) => {
      const q = query.trim();
      if (!q) return;
      navigationRevision.current++;
      saveSnapshot();
      const nextNews = opts.news ?? newsRef.current;
      newsRef.current = nextNews;
      setNewsOptions(nextNews);
      autoAllowed.current = !!opts.typed && nextMode === 'web';
      if (!opts.auto) setMoved(null);
      setInput(q); setMode(nextMode); setHoverCite(null);
      setSince(opts.since); setSort(opts.sort ?? 'relevance');
      setOverviewExpanded(false); setExpandedSnippetKeys([]); setHiddenExpanded(false); setSelectedImage(null); setSiteFilter(null); setHistoryExpired(false);
      pendingPosition.current = { y: 0 }; reading.current = { y: 0 };
      document.title = `${q} - Kiwi Search`;
      writeEntry(entryUrl(q, nextMode, nextNews, opts.since, opts.sort), history);
      if (opts.typed && getUiPreferences().recentQueries) setRecentQueries((items) => rememberQuery(items, q));
      search(q, nextMode, nextMode === 'academic' ? languageRef.current : undefined, nextMode === 'news' ? nextNews : undefined, opts.refresh,
        { summarize: opts.summarize ?? getUiPreferences().summaryMode === 'auto' });
    }, [search, saveSnapshot, writeEntry],
  );

  useEffect(() => {
    let cancelled = false;
    const revision = navigationRevision.current;
    window.history.replaceState({ ...window.history.state, kiwiEntry: entryId.current }, '', location.href);
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    void Promise.all([loadAcademicLanguage(), initializeUiPreferences()]).then(([saved]) => {
      if (cancelled || revision !== navigationRevision.current) return;
      languageRef.current = saved; setAcademicLanguage(saved);
      if (initial.query) {
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        if (navigation?.type === 'back_forward') setHistoryExpired(true);
        else go(initial.query, initial.mode, 'replace', { news: initial.news, since: initial.since, sort: initial.paperSort });
      }
    }).catch(() => {
      if (cancelled || revision !== navigationRevision.current) return;
      setNotice({ text: t('ux.history.loadError') });
      if (initial.query) {
        const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        if (navigation?.type === 'back_forward') setHistoryExpired(true);
        else go(initial.query, initial.mode, 'replace', { news: initial.news, since: initial.since, sort: initial.paperSort, summarize: false });
      }
    });
    return () => { cancelled = true; window.history.scrollRestoration = previous; };
  }, [go, initial]);

  useEffect(() => {
    const onPopState = () => {
      navigationRevision.current++;
      saveSnapshot();
      entryId.current = window.history.state?.kiwiEntry ?? crypto.randomUUID();
      autoAllowed.current = false; setMoved(null); setHoverCite(null);
      const saved = snapshots.current.get(entryId.current);
      if (saved) {
        newsRef.current = saved.newsOptions; languageRef.current = saved.academicLanguage;
        setInput(saved.input); setMode(saved.mode); setNewsOptions(saved.newsOptions);
        setSince(saved.since); setSort(saved.sort); setAcademicLanguage(saved.academicLanguage);
        setOverviewExpanded(saved.overviewExpanded); setExpandedSnippetKeys(saved.expandedSnippetKeys); setHiddenExpanded(saved.hiddenExpanded); setSelectedImage(saved.selectedImage); setSiteFilter(saved.siteFilter);
        if (saved.state) restore(saved.state); else reset();
        document.title = saved.state ? `${saved.state.query} - Kiwi Search` : 'Kiwi Search';
        pendingPosition.current = saved.position; setHistoryExpired(saved.historyExpired);
      } else {
        const next = initialFromUrl();
        reset(); setInput(next.query); setMode(next.mode); setNewsOptions(next.news); newsRef.current = next.news;
        setSince(next.since); setSort(next.paperSort); setSiteFilter(null); setSelectedImage(null); setOverviewExpanded(false); setExpandedSnippetKeys([]); setHiddenExpanded(false);
        setHistoryExpired(!!next.query); pendingPosition.current = { y: 0 };
        document.title = next.query ? `${next.query} - Kiwi Search` : 'Kiwi Search';
      }
      setRestoreTick((value) => value + 1);
    };
    window.addEventListener('popstate', onPopState);
    const onScroll = () => { reading.current = captureReadingPosition(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('popstate', onPopState); window.removeEventListener('scroll', onScroll); };
  }, [saveSnapshot, restore, reset]);

  useLayoutEffect(() => {
    const position = pendingPosition.current ?? reading.current;
    restoreReadingPosition(position); pendingPosition.current = null;
    reading.current = captureReadingPosition();
  }, [state?.results, restoreTick, since, sort, siteFilter, domainOverrides]);

  useEffect(() => { if (!preferences.recentQueries) setRecentQueries([]); }, [preferences.recentQueries]);
  useEffect(() => { if (preferences.summaryMode === 'off') stopSummary(); }, [preferences.summaryMode, stopSummary]);

  const goHome = () => {
    navigationRevision.current++;
    saveSnapshot(); reset(); setInput(''); setHistoryExpired(false); setSiteFilter(null); setSelectedImage(null);
    writeEntry(entryUrl('', mode, newsRef.current), 'push'); document.title = 'Kiwi Search';
    pendingPosition.current = { y: 0 }; setRestoreTick((value) => value + 1);
  };
  const changeAcademicFilters = (nextSince: number | undefined, nextSort: PaperSort) => {
    navigationRevision.current++;
    saveSnapshot(); setSince(nextSince); setSort(nextSort);
    writeEntry(entryUrl(state?.query ?? '', mode, newsRef.current, nextSince, nextSort), 'push');
  };
  const onSiteAction = async (action: 'only' | 'exclude' | 'block' | 'boost', domain: string) => {
    if (action === 'only' || action === 'exclude') { setSiteFilter({ kind: action, domain }); return; }
    const undo = await updateDomainPreference(action, domain);
    setNotice({ text: t(action === 'block' ? 'ux.site.blocked' : 'ux.site.boosted', { domain }), undo, previous: domainOverrides[domain] });
    setDomainOverrides((current) => ({ ...current, [domain]: action }));
  };
  useEffect(() => { if (notice?.undo) undoButton.current?.focus({ preventScroll: true }); }, [notice?.undo]);
  const undoSiteAction = async () => {
    if (!notice?.undo) return;
    const receipt = notice.undo; const previous = notice.previous;
    try {
      const changed = await undoDomainPreference(receipt);
      if (changed) setDomainOverrides((current) => { const next = { ...current }; if (previous) next[receipt.domain] = previous; else delete next[receipt.domain]; return next; });
      setNotice({ text: t(changed ? 'ux.site.undone' : 'ux.site.undoChanged') });
    } catch (error) { setNotice({ ...notice, text: t('ux.site.failed', { detail: error instanceof Error ? error.message : String(error) }) }); }
  };

  const changeMode = (next: SearchMode) => {
    if (next === mode) return;
    if (state) go(state.query, next, 'push');
    else {
      navigationRevision.current++; saveSnapshot(); setMode(next);
      writeEntry(entryUrl('', next, newsRef.current), 'push');
    }
  };

  const changeNews = (next: NewsOptions) => {
    if (next.range === newsRef.current.range && next.sort === newsRef.current.sort) return;
    navigationRevision.current++;
    newsRef.current = next;
    setNewsOptions(next);
    if (state) go(state.query, 'news', 'push', { news: next });
    else { saveSnapshot(); writeEntry(entryUrl('', 'news', next), 'push'); }
  };
  const refreshNews = () => {
    if (state) go(state.query, 'news', 'replace', { news: newsRef.current, refresh: true });
  };

  const changeLanguage = (next: AcademicLanguage) => {
    if (next === languageRef.current) return;
    navigationRevision.current++;
    languageRef.current = next;
    setAcademicLanguage(next);
    void saveAcademicLanguage(next);
    // The same search again with the new limit, in the same history entry.
    if (state?.mode === 'academic') go(state.query, 'academic', 'replace');
  };

  const suggestion: SuggestionAction | null = useMemo(
    () =>
      state
        ? decideSuggestion(
            { query: state.query, mode: state.mode, stage: state.stage, resultCount: state.results.length, suggest: state.suggest },
            { autoAllowed: autoAllowed.current, declinedQuery: declinedQuery.current },
          )
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state?.query, state?.mode, state?.stage, state?.results.length, state?.suggest],
  );

  // Sure enough, and nothing on screen to take away: move to the tab the user is after, replacing this history entry.
  useEffect(() => {
    if (suggestion?.kind !== 'switch' || !state) return;
    setMoved({ query: state.query, mode: suggestion.mode });
    go(state.query, suggestion.mode, 'replace', { auto: true });
  }, [suggestion, state, go]);

  const stayOnWeb = () => {
    if (!moved) return;
    declinedQuery.current = moved.query;
    setMoved(null);
    go(moved.query, 'web', 'replace');
  };

  const idle = !state && !historyExpired;
  const effectiveResults = useMemo(() => {
    const rows = (state?.results ?? []).map((row) => Object.entries(domainOverrides).some(([domain, action]) => action === 'block' && domainMatches(resultHost(row.url), domain)) ? { ...row, hidden: { reason: 'blocked' as const } } : row);
    return rows.sort((a, b) => Number(Object.entries(domainOverrides).some(([domain, action]) => action === 'boost' && domainMatches(resultHost(b.url), domain))) - Number(Object.entries(domainOverrides).some(([domain, action]) => action === 'boost' && domainMatches(resultHost(a.url), domain))));
  }, [state?.results, domainOverrides]);
  const { visible: allVisible, hidden } = useMemo(() => splitResults(effectiveResults), [effectiveResults]);
  const visible = useMemo(() => siteFilter ? allVisible.filter((row) => domainMatches(resultHost(row.url), siteFilter.domain) === (siteFilter.kind === 'only')) : allVisible, [allVisible, siteFilter]);
  const citedUrls = useMemo(() => new Map(state?.citations.map((c) => [c.url, c.n]) ?? []), [state?.citations]);
  const quickAnswer = useMemo(() => state ? extractQuickAnswer(state) : null, [state?.mode, state?.summary, state?.summaryStatus, state?.citations]);
  const showOverview = !!state && preferences.summaryMode !== 'off' && modeHasOverview(state.mode) && (!quickAnswer || !!quickAnswer.remainder);
  // The papers the model named sit in their own block; the filters below apply to the rest.
  const landmarkResults = useMemo(() => (state?.mode === 'academic' ? pickLandmarks(visible, state.landmarks) : []), [state?.mode, state?.landmarks, visible]);
  const papers = useMemo(() => {
    const named = new Set(landmarkResults.map((r) => r.key));
    return sortPapers(filterSince(visible.filter((r) => !named.has(r.key)), since), sort);
  }, [visible, landmarkResults, since, sort]);
  const years = useMemo(() => sinceYears(), []);

  const shown = state?.mode === 'academic' ? papers : visible;
  // In a general search, posts pulled in from Zhihu / Xiaohongshu / WeChat gather in one "各平台怎么说" block after the first few results.
  const { platform: platformPosts, rest: listed } = useMemo(() => (state?.mode === 'web' ? splitPlatforms(shown) : { platform: [], rest: shown }), [state?.mode, shown]);
  const searching = !!state && (state.stage !== 'done' || state.running.length > 0) && !state.fatal;
  const liveStatus = !state
    ? ''
    : state.fatal
      ? t('newtab.app.liveFailed', { error: state.fatal })
      : state.outcome === 'stopped'
        ? t('ux.status.stopped')
        : state.outcome === 'interrupted'
          ? t('ux.status.interrupted')
          : !searching
        ? t('newtab.app.liveDone', { mode: modeLabel(state.mode), count: visible.length })
        : t('newtab.app.liveSearching');

  return (
    <div className={`page${idle ? ' idle' : ''}${state ? ` mode-${state.mode}` : ''}`} onClickCapture={(event) => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('.results a, .overview a, .quick-answer a, a[data-result-link]');
      if (!preferences.openNewTab && link && /^https?:/.test(link.href) && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault(); saveSnapshot(); location.assign(link.href);
      }
    }}>
      {searching && <div className="progress" aria-hidden="true" />}
      <header className="topbar">
        <h1 className="brand">
          <a href={browser.runtime.getURL('/newtab.html')} aria-label={t('brand.home')} onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); goHome(); } }}><KiwiLogo /></a>
        </h1>
        <SearchBox resetToken={`${entryId.current}:${restoreTick}`} value={input} onChange={(value) => { navigationRevision.current++; setInput(value); }} onSubmit={(query) => go(query ?? input, mode, 'push', { typed: true })} recentQueries={preferences.recentQueries ? recentQueries : []} onClearRecent={() => setRecentQueries([])} />
        <QuickSettings optionsUrl={optionsUrl} />
      </header>
      <ModeTabs mode={mode} onChange={changeMode} />
      {idle && mode === 'news' && <div className="news-idle-toolbar"><NewsToolbar value={newsOptions} onChange={changeNews} /></div>}
      <p className="sr-only" role="status">
        {liveStatus}
      </p>

      {notice && <div className="ux-notice" role="status"><span>{notice.text}</span>{notice.undo && <button ref={undoButton} type="button" onClick={() => void undoSiteAction()}>{t('ux.site.undo')}</button>}<button type="button" className="icon-btn" aria-label={t('ux.notice.close')} onClick={() => setNotice(null)}><CloseIcon /></button></div>}
      {historyExpired && <main className="content"><div className="empty"><h3>{t('ux.history.expired')}</h3><p>{t('ux.history.expiredHint')}</p><button type="button" className="btn" onClick={() => go(input, mode, 'replace', { news: newsOptions, since, sort })}>{t('ux.status.retry')}</button></div></main>}
      {state && (
        <main className="content" aria-busy={searching}>
          <StatusLine
            state={state}
            visibleCount={shown.length + landmarkResults.length}
            onStop={stop} onRetry={() => go(state.query, state.mode, 'replace', { news: newsOptions, since, sort })}
            onOpenWorker={(source) => void browser.runtime.sendMessage({ type: 'kiwi:focus-worker', source })}
          />
          <SuggestionLine moved={state.query === moved?.query && state.mode === moved?.mode ? moved : null} offer={moved ? null : suggestion?.kind === 'offer' ? suggestion.mode : null} onStayOnWeb={stayOnWeb} onSwitch={changeMode} />
          {state.fatal && <FatalError message={state.fatal} onRetry={() => go(state.query, state.mode, 'replace', { news: newsOptions, since, sort })} />}

          {/* The overview comes first in the DOM: above the results when the page is narrow, in a column to their right when there is room (see .body in style.css). */}
          <div className={showOverview ? 'body with-rail' : 'body'}>
            {showOverview && (
              <div className="rail">
                <Overview key={`${state.query}|${state.mode}|${state.startedAt}`} state={state} text={quickAnswer?.remainder} optionsUrl={optionsUrl} onHoverCite={setHoverCite} expanded={overviewExpanded} onExpandedChange={setOverviewExpanded} summaryMode={preferences.summaryMode} onGenerate={() => summarize()} onRetry={() => summarize()} onStop={stopSummary} />
                {state.mode === 'news' && state.summary && state.news?.summaryAt && (
                  <p className="overview-note">{t('newtab.news.summaryAt', { time: formatNewsDate(state.news.summaryAt) ?? state.news.summaryAt })}</p>
                )}
                {state.mode === 'news' && state.summaryStale && state.summaryStatus !== 'error' && (
                  <p className="overview-note news-stale" role="status">
                    {t('newtab.news.summaryStale')}
                    <button type="button" onClick={() => summarize({ fresh: true })} disabled={summaryBusy(state.summaryStatus)}>{t('ux.summary.refresh')}</button>
                  </p>
                )}
              </div>
            )}
            <div className="results">
              {siteFilter && <div className="active-filter"><span>{t(siteFilter.kind === 'only' ? 'ux.site.only' : 'ux.site.exclude', { domain: siteFilter.domain })}</span><button type="button" onClick={() => setSiteFilter(null)}>{t('ux.site.clear')}</button></div>}
              {quickAnswer && preferences.summaryMode !== 'off' && <>
                <QuickAnswer answer={quickAnswer} citations={state.citations} onHoverCite={setHoverCite} />
                {!quickAnswer.remainder && <Overview state={state} controlsOnly optionsUrl={optionsUrl} onHoverCite={setHoverCite} summaryMode={preferences.summaryMode} onRetry={() => summarize()} onStop={stopSummary} />}
              </>}
              {state.mode === 'news' && <NewsToolbar value={newsOptions} onChange={changeNews} onRefresh={refreshNews} busy={searching} />}
              {state.mode === 'academic' && state.plan && <PlanLine plan={state.plan} />}
          {state.mode === 'academic' && <Landmarks results={landmarkResults} citedUrls={citedUrls} />}

              {state.mode === 'academic' && (
                <div className="toolbar" role="group" aria-label={t('newtab.app.filterLabel')}>
                  <div className="chips">
                    <button type="button" className="chip" aria-pressed={since === undefined} onClick={() => changeAcademicFilters(undefined, sort)}>
                      {t('newtab.app.anyTime')}
                    </button>
                    {years.map((year) => (
                      <button key={year} type="button" className="chip" aria-pressed={since === year} onClick={() => changeAcademicFilters(year, sort)}>
                        {t('newtab.app.sinceYear', { year })}
                      </button>
                    ))}
                  </div>
                  <button type="button" className="chip" aria-pressed={sort === 'citations'} onClick={() => changeAcademicFilters(since, sort === 'citations' ? 'relevance' : 'citations')}>
                    {t('newtab.app.sortByCitations')}
                  </button>
                </div>
              )}
              {/* Its own row: the time chips and the sort chip already fill the column (42rem), so a third group would wrap by chance. */}
              {state.mode === 'academic' && (
                <div className="chips lang-chips" role="group" aria-label={t('newtab.academic.languageLabel')}>
                  <button type="button" className="chip" aria-pressed={academicLanguage === 'any'} onClick={() => changeLanguage('any')}>
                    {t('newtab.academic.languageAny')}
                  </button>
                  <button type="button" className="chip" aria-pressed={academicLanguage === 'en'} onClick={() => changeLanguage('en')}>
                    {t('newtab.academic.languageEn')}
                  </button>
                </div>
              )}
              {state.mode === 'academic' && academicLanguage === 'en' && state.stage === 'done' && !state.plan && hasCjk(state.query) && (
                <p className="lang-note">{t('newtab.academic.languageNoPlan')}</p>
              )}

              {shown.length === 0 && state.stage === 'searching' && !state.fatal && <ListSkeleton mode={state.mode} />}
              {shown.length === 0 && landmarkResults.length === 0 && state.stage !== 'searching' && !state.fatal && (
                <EmptyState mode={state.mode} waitingForVerification={state.blocked.length > 0} optionsUrl={optionsUrl} state={state} hiddenCount={hidden.length} filtered={!!siteFilter || since !== undefined} onClearFilters={() => { setSiteFilter(null); changeAcademicFilters(undefined, 'relevance'); }} onRetry={() => go(state.query, state.mode, 'replace', { news: newsOptions, since, sort })} />
              )}
              {shown.length > 0 &&
                (state.mode === 'images' ? (
                  <ImageResults results={shown} selectedUrl={selectedImage} onSelectedChange={setSelectedImage} />
                ) : state.mode === 'xiaohongshu' ? (
                  <NoteResults results={shown} />
                ) : (
                  <ResultList
                results={listed} siteMenu onSiteAction={onSiteAction}
                expandedSnippetKeys={expandedSnippetKeys} onSnippetExpandedChange={(key, expanded) => setExpandedSnippetKeys((keys) => expanded ? [...new Set([...keys, key])] : keys.filter((item) => item !== key))}
                mode={state.mode}
                hoverCite={hoverCite}
                citedUrls={citedUrls}
                between={platformPosts.length ? { after: 3, node: <PlatformStrip key="platforms" results={platformPosts} hoverCite={hoverCite} citedUrls={citedUrls} onOpenTab={changeMode} /> } : undefined}
              />
                ))}
              {state.mode !== 'images' && <HiddenResults results={hidden} mode={state.mode} open={hiddenExpanded} onOpenChange={setHiddenExpanded} />}
            </div>
          </div>
        </main>
      )}
    </div>
  );
}
