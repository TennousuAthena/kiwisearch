import type { SearchMode, SourceId, SuggestMode } from '@kiwi-search/core';
import { t } from '@/lib/i18n';
import { CircleAlertIcon, RotateIcon, TriangleAlertIcon } from '@/lib/icons';
import { decisionModelNotes, formatDuration, modeLabel } from '@/lib/results';
import { firstBlocked, type SearchState } from '@/lib/searchState';
import { offerText, suggestionName } from '@/lib/suggestion';

interface StatusProps {
  state: SearchState;
  visibleCount: number;
  /** Bring the blocked source's own page forward, to solve its captcha or sign in. */
  onOpenWorker: (source: SourceId) => void;
}

/** One quiet line under the tabs: the count, plus the few things that need the user's attention. */
export function StatusLine({ state, visibleCount, onOpenWorker }: StatusProps) {
  const login = firstBlocked(state, 'login');
  const captcha = firstBlocked(state, 'captcha');
  const done = state.stage === 'done' && !state.fatal;
  const loadingMore = state.stage === 'done' && state.running.length > 0;
  return (
    <div className="status">
      {done && (
        <span>{t('newtab.status.resultCount', { count: visibleCount, duration: formatDuration((state.finishedAt ?? state.startedAt) - state.startedAt) })}</span>
      )}
      {loadingMore && <span>{t('newtab.status.loadingMore')}</span>}
      {login && (
        <button type="button" className="status-action warn" onClick={() => onOpenWorker(login)}>
          <TriangleAlertIcon />
          {t('newtab.status.loginNeeded')}
        </button>
      )}
      {captcha && (
        <button type="button" className="status-action warn" onClick={() => onOpenWorker(captcha)}>
          <TriangleAlertIcon />
          {t('newtab.status.captchaNeeded')}
        </button>
      )}
      {done &&
        decisionModelNotes(state).map((note) => (
          <span key={note.text} title={note.title}>
            {note.text}
          </span>
        ))}
      {done && state.mode === 'academic' && state.planError && <span title={state.planError}>{t('newtab.status.planFailed', { error: state.planError })}</span>}
    </div>
  );
}

/**
 * One quiet line about the tab the decision model thinks the user wants: either "we moved you there" with the way back,
 * or an offer to go. Nothing when there is nothing to say.
 */
export function SuggestionLine({
  moved,
  offer,
  onStayOnWeb,
  onSwitch,
}: {
  moved: { mode: SearchMode } | null;
  offer: SuggestMode | null;
  onStayOnWeb: () => void;
  onSwitch: (mode: SuggestMode) => void;
}) {
  if (moved) {
    return (
      <div className="status suggestion">
        <span>{t('newtab.status.suggestionMoved', { mode: modeLabel(moved.mode) })}</span>
        <button type="button" className="status-action" onClick={onStayOnWeb}>
          {t('newtab.status.suggestionStay')}
        </button>
      </div>
    );
  }
  if (!offer) return null;
  return (
    <div className="status suggestion">
      <span>{offerText(offer)}</span>
      <button type="button" className="status-action" onClick={() => onSwitch(offer)}>
        {t('newtab.status.suggestionSwitch', { name: suggestionName(offer) })}
      </button>
    </div>
  );
}

export function FatalError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="alert" role="alert">
      <CircleAlertIcon />
      <div className="alert-body">
        <strong>{t('newtab.status.fatalTitle')}</strong>
        <p>{message}</p>
      </div>
      <button type="button" className="btn" onClick={onRetry}>
        <RotateIcon />
        {t('newtab.status.fatalRetry')}
      </button>
    </div>
  );
}

export function EmptyState({ mode, waitingForVerification, optionsUrl }: { mode: SearchMode; waitingForVerification: boolean; optionsUrl: string }) {
  return (
    <div className="empty">
      <h3>{t('newtab.status.emptyTitle')}</h3>
      <p>{waitingForVerification ? t('newtab.status.emptyWaiting') : t(`newtab.status.emptyHint.${mode}`)}</p>
      {!waitingForVerification && (
        <a href={optionsUrl} target="_blank" rel="noreferrer">
          {t('newtab.status.openSettings')}
        </a>
      )}
    </div>
  );
}

export function ListSkeleton({ mode }: { mode: SearchMode }) {
  if (mode === 'images') {
    return (
      <div className="image-skeleton" aria-hidden="true">
        {[1.5, 1, 1.8, 1.2, 1, 1.6, 1.3, 1, 1.7, 1.1].map((ratio, i) => (
          <div key={i} className="sk" style={{ flexGrow: ratio, flexBasis: `${ratio * 140}px`, height: 170 }} />
        ))}
      </div>
    );
  }
  if (mode === 'xiaohongshu') {
    return (
      <div className="notes" aria-hidden="true">
        {[220, 170, 250, 190, 210, 160, 240, 180].map((height, i) => (
          <div key={i} className="sk note-sk" style={{ height }} />
        ))}
      </div>
    );
  }
  if (mode === 'video') {
    return (
      <div className="result-list" aria-hidden="true">
        {[78, 64, 86, 58].map((width, i) => (
          <div key={i} className="result video">
            <div className="sk video-thumb" />
            <div>
              <div className="sk sk-title" style={{ width: `${width}%` }} />
              <div className="sk sk-line" style={{ width: '45%' }} />
              <div className="sk sk-line" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="result-list" aria-hidden="true">
      {[78, 64, 86, 58, 72].map((width, i) => (
        <div key={i} className="result">
          <div className="sk sk-site" />
          <div className="sk sk-title" style={{ width: `${width}%` }} />
          <div className="sk sk-line" />
          <div className="sk sk-line" style={{ width: '82%' }} />
        </div>
      ))}
    </div>
  );
}
