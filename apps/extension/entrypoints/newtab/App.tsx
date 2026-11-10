import type { Citation, FusedResult, PipelineEvent, SourceId } from '@fusion-search/core';
import type { ChatMessage } from '@fusion-search/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Browser } from 'wxt/browser';
import { browser } from 'wxt/browser';
import { renderSummary } from '@/lib/markdown';
import type { PortMessage, SearchRequest } from '@/lib/messages';
import { SOURCE_META, faviconUrl } from '@/lib/sourceMeta';

type SourceState = { status: 'loading' | 'blocked' | 'done' | 'error'; count?: number; ms?: number; error?: string };

interface SearchState {
  query: string;
  sources: Partial<Record<SourceId, SourceState>>;
  results: FusedResult[];
  stage: 'searching' | 'reranking' | 'summarizing' | 'done';
  rerankInfo?: string;
  citations: Citation[];
  summary: string;
  summaryStatus: 'idle' | 'loading' | 'streaming' | 'done' | 'error';
  summaryError?: string;
  fatal?: string;
}

const emptyState = (query: string): SearchState => ({
  query,
  sources: {},
  results: [],
  stage: 'searching',
  citations: [],
  summary: '',
  summaryStatus: 'idle',
});

function reduce(s: SearchState, e: PipelineEvent): SearchState {
  switch (e.type) {
    case 'source_start':
      return { ...s, sources: { ...s.sources, [e.source]: { status: 'loading' } } };
    case 'source_blocked':
      return { ...s, sources: { ...s.sources, [e.source]: { status: 'blocked', error: e.message } } };
    case 'source_done':
      return { ...s, sources: { ...s.sources, [e.source]: { status: 'done', count: e.count, ms: e.ms } } };
    case 'source_error':
      return { ...s, sources: { ...s.sources, [e.source]: { status: 'error', error: e.error, ms: e.ms } } };
    case 'fused':
      return { ...s, results: e.results, stage: 'reranking' };
    case 'reranked':
      return {
        ...s,
        results: e.results,
        stage: 'summarizing',
        rerankInfo: e.error ? `重排失败（${e.error}），已按 RRF 排序` : `已用 ${e.provider === 'llm' ? 'LLM' : e.provider} 重排`,
      };
    case 'summary_start':
      return { ...s, citations: e.citations, summaryStatus: 'loading' };
    case 'summary_prompt':
      return { ...s, citations: e.citations, summaryStatus: 'loading' };
    case 'summary_delta':
      return { ...s, summary: s.summary + e.text, summaryStatus: 'streaming' };
    case 'summary_done':
      return { ...s, summaryStatus: 'done' };
    case 'summary_error':
      return { ...s, summaryStatus: 'error', summaryError: e.error };
    case 'done':
      return { ...s, stage: 'done', results: s.results.length ? s.results : e.result.results };
  }
}

export default function App() {
  const initialQuery = useMemo(() => new URLSearchParams(location.search).get('q') ?? '', []);
  const [input, setInput] = useState(initialQuery);
  const [state, setState] = useState<SearchState | null>(null);
  const [hoverCite, setHoverCite] = useState<number | null>(null);
  const portRef = useRef<Browser.runtime.Port | null>(null);
  const keepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useCallback((q: string) => {
    q = q.trim();
    if (!q) return;
    if (keepaliveRef.current) clearInterval(keepaliveRef.current);
    portRef.current?.disconnect();
    const port = browser.runtime.connect({ name: 'search' });
    portRef.current = port;
    keepaliveRef.current = setInterval(() => {
      if (portRef.current !== port) return;
      try {
        port.postMessage({ type: 'keepalive' });
      } catch {
        portRef.current = null;
        if (keepaliveRef.current) clearInterval(keepaliveRef.current);
        keepaliveRef.current = null;
      }
    }, 20000);
    port.onDisconnect.addListener(() => {
      if (portRef.current === port) {
        portRef.current = null;
        if (keepaliveRef.current) clearInterval(keepaliveRef.current);
        keepaliveRef.current = null;
      }
    });
    setState(emptyState(q));
    document.title = `${q} - Fusion Search`;
    const url = new URL(location.href);
    url.searchParams.set('q', q);
    history.replaceState(null, '', url);
    port.onMessage.addListener((raw: unknown) => {
      if (portRef.current !== port) return;
      const msg = raw as PortMessage;
      if (msg.type === 'fatal') {
        if (keepaliveRef.current) clearInterval(keepaliveRef.current);
        keepaliveRef.current = null;
        setState((s) => s && { ...s, fatal: msg.error, stage: 'done' });
      }
      else {
        setState((s) => s && reduce(s, msg.event));
        if (msg.event.type === 'done') {
          if (keepaliveRef.current) clearInterval(keepaliveRef.current);
          keepaliveRef.current = null;
        }
        if (msg.event.type === 'summary_prompt') {
          void promptWithBuiltinModel(msg.event.messages, (delta) => {
            setState((s) => s && { ...s, summary: s.summary + delta, summaryStatus: 'streaming' });
          })
            .then(() => setState((s) => s && { ...s, summaryStatus: 'done' }))
            .catch((error) => setState((s) => s && { ...s, summaryStatus: 'error', summaryError: error instanceof Error ? error.message : String(error) }));
        }
      }
    });
    const req: SearchRequest = { type: 'search', query: q };
    port.postMessage(req);
  }, []);

  useEffect(() => {
    if (initialQuery) search(initialQuery);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [initialQuery, search]);

  const summaryHtml = useMemo(
    () => (state?.summary ? renderSummary(state.summary, state.citations) : ''),
    [state?.summary, state?.citations],
  );
  const citedUrls = useMemo(() => new Map(state?.citations.map((c) => [c.url, c.n]) ?? []), [state?.citations]);

  const idle = !state;
  return (
    <div className={idle ? 'page idle' : 'page'}>
      <header className="topbar">
        <form
          className="searchbox"
          onSubmit={(e) => {
            e.preventDefault();
            search(input);
          }}
        >
          <span className="logo">Fusion</span>
          <input
            ref={inputRef}
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="搜索 Google、Bing、OpenAlex、Exa、DeepSeek…"
            spellCheck={false}
          />
          <button type="submit">搜索</button>
        </form>
        <a className="settings" href={browser.runtime.getURL('/options.html')} target="_blank" title="设置">
          ⚙
        </a>
      </header>

      {state && (
        <>
          <div className="sources">
            {(Object.entries(state.sources) as [SourceId, SourceState][]).map(([id, s]) => (
              s.status === 'blocked' ? (
                <button key={id} className="chip blocked" title={s.error} onClick={() => void browser.runtime.sendMessage({ type: 'fusion:focus-worker', source: id })}>
                  <i style={{ background: SOURCE_META[id].color }} />
                  {SOURCE_META[id].label}
                  <small>需要验证</small>
                </button>
              ) : (
                <span key={id} className={`chip ${s.status}`} title={s.error ?? ''}>
                  <i style={{ background: SOURCE_META[id].color }} />
                  {SOURCE_META[id].label}
                  {s.status === 'loading' && <em className="spinner" />}
                  {s.status === 'done' && <small>{s.count} · {s.ms}ms</small>}
                  {s.status === 'error' && <small>失败</small>}
                </span>
              )
            ))}
            {state.rerankInfo && <span className="note">{state.rerankInfo}</span>}
          </div>
          {state.fatal && <div className="error">{state.fatal}</div>}

          <main className="layout">
            <section className="results">
              {state.results.length === 0 && state.stage === 'searching' && <div className="placeholder">检索中…</div>}
              {state.results.length === 0 && state.stage !== 'searching' && !state.fatal && (
                <div className="placeholder">没有结果</div>
              )}
              {state.results.map((r) => {
                const n = citedUrls.get(r.url);
                return (
                  <article key={r.key} className={`result ${n && n === hoverCite ? 'hl' : ''}`} id={n ? `cite-${n}` : undefined}>
                    <div className="site">
                      <img src={faviconUrl(r.url)} alt="" />
                      <span className="host">{prettyUrl(r.url)}</span>
                      {n && <span className="cite-n">[{n}]</span>}
                    </div>
                    <a className="title" href={r.url} target="_blank" rel="noreferrer">
                      {r.title}
                    </a>
                    <p className="snippet">{r.snippet}</p>
                    <div className="meta">
                      {r.sources.map((s) => (
                        <span key={s.source} className="badge" style={{ borderColor: SOURCE_META[s.source].color, color: SOURCE_META[s.source].color }}>
                          {SOURCE_META[s.source].short} #{s.rank}
                        </span>
                      ))}
                      {r.meta.citations !== undefined && <span className="extra">被引 {r.meta.citations}</span>}
                      {r.meta.year && <span className="extra">{r.meta.year}</span>}
                      {!r.meta.year && r.publishedAt && <span className="extra">{r.publishedAt.slice(0, 10)}</span>}
                      <span className="score" title={`RRF ${r.rrfScore.toFixed(4)}${r.rerankScore !== undefined ? ` · rerank ${r.rerankScore.toFixed(2)}` : ''}`}>
                        <b style={{ width: `${Math.round(r.score * 100)}%` }} />
                      </span>
                    </div>
                  </article>
                );
              })}
            </section>

            <aside className="summary">
              <div className="card">
                <h2>AI 摘要</h2>
                {state.summaryStatus === 'idle' && state.stage === 'done' && (
                  <p className="muted">
                    未生成摘要：请在 <a href={browser.runtime.getURL('/options.html')} target="_blank">设置</a> 中配置 LLM。
                  </p>
                )}
                {state.summaryStatus === 'idle' && state.stage !== 'done' && <p className="muted">等待检索与重排…</p>}
                {state.summaryStatus === 'loading' && <p className="muted">正在读取前 {state.citations.length} 篇来源…</p>}
                {state.summaryStatus === 'error' && <p className="error">{state.summaryError}</p>}
                {summaryHtml && (
                  <div
                    className={`md ${state.summaryStatus === 'streaming' ? 'streaming' : ''}`}
                    onMouseOver={(e) => {
                      const n = (e.target as HTMLElement).closest('a.cite')?.getAttribute('data-n');
                      setHoverCite(n ? Number(n) : null);
                    }}
                    onMouseOut={() => setHoverCite(null)}
                    dangerouslySetInnerHTML={{ __html: summaryHtml }}
                  />
                )}
                {state.citations.length > 0 && state.summaryStatus === 'done' && (
                  <ol className="refs">
                    {state.citations.map((c) => (
                      <li key={c.n} onMouseEnter={() => setHoverCite(c.n)} onMouseLeave={() => setHoverCite(null)}>
                        <a href={c.url} target="_blank" rel="noreferrer">
                          {c.title}
                        </a>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </aside>
          </main>
        </>
      )}
    </div>
  );
}

function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : decodeURI(u.pathname);
    return u.hostname.replace(/^www\./, '') + (path.length > 50 ? path.slice(0, 50) + '…' : path);
  } catch {
    return url;
  }
}

interface PromptSession {
  promptStreaming(input: string): Promise<ReadableStream<string>>;
  destroy?(): void;
}

interface PromptApi {
  availability(): Promise<string>;
  create(): Promise<PromptSession>;
}

async function promptWithBuiltinModel(messages: ChatMessage[], onDelta: (delta: string) => void): Promise<void> {
  const model = (globalThis as typeof globalThis & { LanguageModel?: PromptApi }).LanguageModel;
  if (!model) throw new Error('当前浏览器不支持内置模型');
  const availability = await model.availability();
  if (!['available', 'downloadable', 'downloading'].includes(availability)) throw new Error('当前浏览器不支持内置模型');
  const session = await model.create();
  try {
    const prompt = messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
    const reader = (await session.promptStreaming(prompt)).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) onDelta(value);
    }
  } finally {
    session.destroy?.();
  }
}
