import type { AcademicLanguage, FusedResult, NewsOptions, SearchMode, SourceId, SummaryPhase } from '@kiwi-search/core';
import type { PortMessage, SummaryRequest } from '@kiwi-search/protocol';
import { t } from '../i18n';
import { newsEvidence } from './news';
import { emptyState, endSession, lateSourcesAfterDone, reduce, restoreSnapshot, summaryBusy, summaryWorking, type SearchState } from './searchState';
import type { promptWithBuiltinModel } from './builtinModel';

export interface SessionPort {
  postMessage(message: unknown): void; disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}
interface Lane {
  port: SessionPort; kind: 'search' | 'summary'; closed: boolean; done: boolean; acceptSummary: boolean;
  deferred: Set<SourceId>; timer?: ReturnType<typeof setInterval>;
  builtin?: AbortController; builtinTimer?: ReturnType<typeof setTimeout>;
  evidence?: string; reuse?: boolean; evidenceResults?: FusedResult[];
}
export interface SearchOptions { summarize?: boolean }

/** Independent of React so real port ordering, cancellation and timers can be tested. */
export function createSearchSessionController(deps: {
  connect: (name: 'search' | 'summary') => SessionPort;
  prompt: typeof promptWithBuiltinModel;
  onChange: (state: SearchState | null) => void;
}) {
  let state: SearchState | null = null;
  let main: Lane | null = null;
  let summary: Lane | null = null;
  const set = (next: SearchState | null) => { state = next; deps.onChange(next); };
  const change = (fn: (s: SearchState) => SearchState) => { if (state) set(fn(state)); };
  const current = (lane: Lane) => !lane.closed && (lane.kind === 'search' ? main === lane : summary === lane);
  const abortBuiltin = (lane: Lane) => {
    lane.builtin?.abort(); lane.builtin = undefined;
    if (lane.builtinTimer) clearTimeout(lane.builtinTimer);
    lane.builtinTimer = undefined;
  };
  const close = (lane: Lane | null) => {
    if (!lane) return;
    lane.closed = true;
    if (lane.timer) clearInterval(lane.timer);
    abortBuiltin(lane);
    try { lane.port.disconnect(); } catch { /* Already disconnected. */ }
  };
  const teardown = () => { close(main); close(summary); main = null; summary = null; };
  const settle = (lane: Lane) => {
    if (!current(lane)) return;
    const waitingForSummary = lane.acceptSummary && !!state && summaryWorking(state);
    if (lane.done && lane.deferred.size === 0 && !waitingForSummary && lane.timer) {
      clearInterval(lane.timer); lane.timer = undefined;
    }
  };
  const disconnected = (lane: Lane) => {
    if (!current(lane)) return;
    const expected = !lane.done || lane.deferred.size > 0 || (lane.acceptSummary && !!state && summaryWorking(state));
    close(lane);
    if (!expected) return;
    if (lane.kind === 'summary') change((s) => ({ ...s, summaryStatus: 'error', summaryError: t('newtab.session.summaryInterrupted') }));
    else if (state?.summaryUpdate && lane.done && lane.deferred.size === 0) change((s) => reduce(s, { type: 'summary_error', error: t('newtab.session.summaryInterrupted'), phase: 'final' }));
    else {
      close(summary); summary = null;
      change((s) => endSession(s, 'interrupted', t('newtab.session.interrupted')));
    }
  };
  // The page's built-in model reports through the same reducer events as the API model, so an early overview's phase is kept.
  const runBuiltin = (lane: Lane, messages: Parameters<typeof promptWithBuiltinModel>[0], phase?: SummaryPhase) => {
    abortBuiltin(lane);
    const controller = new AbortController(); lane.builtin = controller;
    const valid = () => current(lane) && lane.acceptSummary && lane.builtin === controller;
    const armTimeout = () => {
      if (lane.builtinTimer) clearTimeout(lane.builtinTimer);
      lane.builtinTimer = setTimeout(() => {
        if (!valid()) return;
        abortBuiltin(lane);
        change((s) => reduce(s, { type: 'summary_error', error: t('newtab.session.builtinModelTimeout'), phase }));
        settle(lane);
      }, 60000);
    };
    armTimeout();
    void deps.prompt(messages, (delta) => {
      if (!valid()) return;
      armTimeout();
      change((s) => reduce(s, { type: 'summary_delta', text: delta, phase }));
    }, controller.signal).then(() => {
      if (valid()) change((s) => reduce(s, { type: 'summary_done', text: '', phase }));
    }).catch((error: unknown) => {
      if (valid()) change((s) => reduce(s, { type: 'summary_error', error: t('newtab.session.builtinModelFailed', { detail: error instanceof Error ? error.message : String(error) }), phase }));
    }).finally(() => {
      if (lane.builtin === controller) { abortBuiltin(lane); settle(lane); }
    });
  };
  const open = (kind: Lane['kind']): Lane => {
    const lane: Lane = { port: deps.connect(kind), kind, closed: false, done: kind === 'summary', acceptSummary: true, deferred: new Set() };
    if (kind === 'search') main = lane; else summary = lane;
    lane.timer = setInterval(() => {
      if (!current(lane)) return;
      try { lane.port.postMessage({ type: 'keepalive' }); } catch { disconnected(lane); }
    }, 20000);
    lane.port.onDisconnect.addListener(() => disconnected(lane));
    lane.port.onMessage.addListener((raw) => {
      if (!current(lane) || !raw || typeof raw !== 'object') return;
      const msg = raw as PortMessage;
      if (msg.type === 'readiness') { change((s) => ({ ...s, readiness: { enabled: msg.enabled, ready: msg.ready } })); return; }
      if (msg.type === 'summary-snapshot') {
        if (!lane.acceptSummary) return;
        // The final overview's evidence waits with it until it replaces the early one on screen.
        change((s) => s.summaryUpdate ? { ...s, summaryUpdate: { ...s.summaryUpdate, results: structuredClone(msg.results), summaryAt: msg.summaryAt } }
          : { ...s, summaryResults: structuredClone(msg.results), summaryAt: msg.summaryAt, news: s.news ? { ...s.news, summaryAt: msg.summaryAt } : s.news });
        return;
      }
      if (msg.type === 'fatal') {
        if (kind === 'summary') change((s) => ({ ...s, summaryStatus: 'error', summaryError: msg.error }));
        else { close(summary); summary = null; change((s) => ({ ...endSession(s, 'interrupted'), fatal: msg.error })); }
        close(lane); return;
      }
      if (msg.type !== 'event' || !msg.event || typeof msg.event.type !== 'string') return;
      const event = msg.event;
      if (event.type.startsWith('summary_') && !lane.acceptSummary) return;
      if (kind === 'summary' && !event.type.startsWith('summary_')) return;
      if (event.type === 'source_blocked') lane.deferred.add(event.source);
      if (event.type === 'late_results' || event.type === 'source_error') lane.deferred.delete(event.source);
      change((s) => {
        const next = reduce(s, event);
        if (kind === 'summary' && event.type === 'summary_start') {
          next.summaryEvidence = lane.evidence;
          next.summaryStale = s.mode === 'news' && lane.evidence !== undefined && newsEvidence(s.results) !== lane.evidence;
          next.summaryResults = structuredClone(event.citations.flatMap((cite) => {
            const result = lane.evidenceResults?.find((r) => r.url === cite.url);
            if (!result) return [];
            if (lane.reuse) return [result];
            const { content: _content, ...excerpt } = result;
            return [excerpt];
          }));
        }
        return next;
      });
      if (event.type === 'done') { lane.done = true; for (const id of lateSourcesAfterDone(event)) lane.deferred.add(id); }
      if (event.type === 'summary_prompt') runBuiltin(lane, event.messages, event.phase);
      settle(lane);
    });
    return lane;
  };
  const stopSummary = () => {
    if (main) {
      main.acceptSummary = false; abortBuiltin(main);
      try { main.port.postMessage({ type: 'stop-summary' }); } catch { disconnected(main); }
    }
    close(summary); summary = null;
    // Stopping the final overview leaves the early one on screen as it was.
    change((s) => s.summaryUpdate ? { ...s, summaryUpdate: undefined } : summaryBusy(s.summaryStatus) ? { ...s, summaryStatus: 'stopped', summaryError: undefined } : s);
    if (main) settle(main);
  };
  return {
    getState: () => state,
    search(query: string, mode: SearchMode, language?: AcademicLanguage, news?: NewsOptions, refresh?: boolean, options: SearchOptions = {}) {
      teardown();
      const initial = emptyState(query, mode);
      if (mode === 'news') initial.news = { range: news?.range ?? 'any', sort: news?.sort ?? 'relevance', requestedAt: new Date(initial.startedAt).toISOString() };
      set(initial);
      try {
        const lane = open('search');
        // `phases`: this page shows the early overview and its replacement; without it the extension writes one overview.
        lane.port.postMessage({ type: 'search', query, mode, phases: true, ...(language ? { language } : {}), ...(news ? { news } : {}),
          ...(refresh ? { refresh: true } : {}), ...(options.summarize !== undefined ? { summarize: options.summarize } : {}) });
      } catch { if (main) disconnected(main); else change((s) => endSession(s, 'interrupted', t('newtab.session.interrupted'))); }
    },
    stop() { teardown(); change((s) => endSession(s, 'stopped')); },
    reset() { teardown(); set(null); },
    restore(snapshot: SearchState) { teardown(); set(restoreSnapshot(snapshot)); },
    summarize(options: { fresh?: boolean } = {}) {
      if (!state) return;
      stopSummary();
      const reuse = !options.fresh && state.summaryResults.length > 0;
      const snapshot = structuredClone(reuse ? state.summaryResults : state.results.filter((r) => !r.hidden && (r.snippet || r.content)));
      if (!snapshot.length) { change((s) => ({ ...s, summaryStatus: 'error', summaryError: t('newtab.session.summaryNoEvidence') })); return; }
      const evidence = state.mode === 'news' ? (reuse ? state.summaryEvidence : newsEvidence(state.results)) : undefined;
      const request: SummaryRequest = { type: 'summarize', query: state.query, mode: state.mode, results: snapshot.slice(0, 100), news: state.news,
        reuse, ...(reuse && state.summaryAt ? { summaryAt: state.summaryAt } : {}) };
      change((s) => ({ ...s, summaryStatus: 'loading', summaryError: undefined }));
      try { const lane = open('summary'); lane.evidence = evidence; lane.reuse = reuse; lane.evidenceResults = snapshot; lane.port.postMessage(request); }
      catch { if (summary) disconnected(summary); else change((s) => ({ ...s, summaryStatus: 'error', summaryError: t('newtab.session.summaryInterrupted') })); }
    },
    stopSummary,
    dispose: teardown,
  };
}
