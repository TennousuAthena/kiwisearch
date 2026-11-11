import type { SearchMode } from '@kiwi-search/core';
import { CircleAlertIcon, RotateIcon, TriangleAlertIcon } from '@/lib/icons';
import { formatDuration } from '@/lib/results';
import type { SearchState } from '@/lib/searchState';

interface StatusProps {
  state: SearchState;
  visibleCount: number;
  onVerify: () => void;
}

/** One quiet line under the tabs: the count, plus the few things that need the user's attention. */
export function StatusLine({ state, visibleCount, onVerify }: StatusProps) {
  const done = state.stage === 'done' && !state.fatal;
  const loadingMore = state.stage === 'done' && state.running.length > 0;
  return (
    <div className="status">
      {done && (
        <span>
          {visibleCount} 条结果（{formatDuration((state.finishedAt ?? state.startedAt) - state.startedAt)}）
        </span>
      )}
      {loadingMore && <span>仍在加载更多结果…</span>}
      {state.blocked.length > 0 && (
        <button type="button" className="status-action" onClick={onVerify}>
          <TriangleAlertIcon />
          有来源需要人机验证，暂时没有它的结果 · 去验证
        </button>
      )}
      {done && state.judgeError && <span title={state.judgeError}>智能过滤未完全生效：{state.judgeError}</span>}
    </div>
  );
}

export function FatalError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="alert" role="alert">
      <CircleAlertIcon />
      <div className="alert-body">
        <strong>搜索失败</strong>
        <p>{message}</p>
      </div>
      <button type="button" className="btn" onClick={onRetry}>
        <RotateIcon />
        重试
      </button>
    </div>
  );
}

const EMPTY_HINTS: Record<SearchMode, string> = {
  web: '试试换个关键词，或在设置里启用更多搜索来源。',
  images: '图片搜索需要启用 Bing（浏览器渲染）或 Openverse，可在设置里检查。',
  video: '视频搜索需要启用 YouTube 或哔哩哔哩（浏览器渲染），可在设置里检查。',
  zhihu: '知乎搜索需要在这个浏览器里登录知乎，并在设置里启用知乎。',
  x: 'X 搜索需要在这个浏览器里登录 X，并在设置里启用 X。X 对自动化使用管得很严，请适度使用。',
  wechat: '公众号搜索需要启用“搜狗微信”（浏览器渲染），可在设置里检查。搜狗偶尔会要求人机验证。',
  xiaohongshu: '小红书搜索需要在这个浏览器里登录小红书（国内站或 RedNote），并在设置里启用你登录的那个站点。',
  academic: '试试用英文关键词或论文标题，也可以在设置里启用更多学术来源。',
};

export function EmptyState({ mode, waitingForVerification, optionsUrl }: { mode: SearchMode; waitingForVerification: boolean; optionsUrl: string }) {
  return (
    <div className="empty">
      <h3>没有找到相关结果</h3>
      <p>{waitingForVerification ? '有来源正在等待验证。完成验证后，结果会自动补充到这里。' : EMPTY_HINTS[mode]}</p>
      {!waitingForVerification && (
        <a href={optionsUrl} target="_blank" rel="noreferrer">
          打开设置
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
