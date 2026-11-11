import { BROWSER_ENGINES, DEFAULT_CONFIG, SOURCES, type FusionConfig, type SourceId } from '@kiwi-search/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { CheckIcon, CopyIcon, TriangleAlertIcon } from '@/lib/icons';
import { DEFAULT_BRIDGE, loadBridge, loadConfig, saveBridge, saveConfig, type BridgeSettings } from '@/lib/settings';
import { MODE_LABELS } from '@/lib/results';
import { SOURCE_LABELS } from '@/lib/sourceMeta';

const defaultSearchFields = [
  { id: 'name', label: '名称', value: 'Kiwi Search' },
  { id: 'keyword', label: '快捷字词', value: 'kiwi' },
  { id: 'url', label: '网址', value: 'https://s.kiwi.moe/s?q=%s' },
] as const;

const apiSourceIds: SourceId[] = ['openalex', 'crossref', 'arxiv', 'openverse', 'exa', 'deepseek', 'brave', 'searxng'];
/** Sources that are off by default for a reason: turning one on asks first, with this as the reason. */
const CONFIRM_ENABLE: Partial<Record<SourceId, string>> = {
  baidu: '百度的结果页里混有翻译、推荐等并不是搜索结果的卡片，开启后它们会出现在你的搜索结果里。默认关闭，之后随时可以再关掉。',
};
const presets = [
  { id: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  { id: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
];

const sections = [
  { id: 'default-search', label: '默认搜索引擎' },
  { id: 'sources', label: '来源' },
  { id: 'renderer', label: '渲染' },
  { id: 'judge', label: '结果过滤' },
  { id: 'llm', label: 'LLM' },
  { id: 'rerank', label: '重排' },
  { id: 'mcp', label: 'MCP 桥' },
];

export default function OptionsApp() {
  const [config, setConfig] = useState<FusionConfig>(() => structuredClone(DEFAULT_CONFIG));
  const [bridge, setBridge] = useState<BridgeSettings>(DEFAULT_BRIDGE);
  const [saved, setSaved] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [copyError, setCopyError] = useState('');
  const [settingsFallback, setSettingsFallback] = useState(false);
  const [confirming, setConfirming] = useState<SourceId | null>(null);

  useEffect(() => {
    void Promise.all([loadConfig(), loadBridge()]).then(([nextConfig, nextBridge]) => {
      setConfig(nextConfig);
      setBridge(nextBridge);
    });
  }, []);

  function updateSource(id: SourceId, field: 'enabled' | 'apiKey' | 'baseUrl' | 'weight', value: boolean | string | number) {
    setConfig((current) => ({
      ...current,
      sources: {
        ...current.sources,
        [id]: { ...current.sources[id], [field]: value },
      },
    }));
  }

  async function save() {
    await Promise.all([saveConfig(config), saveBridge(bridge)]);
    setSaved(true);
    setTimeout(() => setSaved(false), 2200);
  }

  async function copyDefaultSearchField(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(id);
      setCopyError('');
      window.setTimeout(() => setCopiedField(null), 1600);
    } catch {
      setCopyError('复制失败，请手动选择并复制上面的内容。');
    }
  }

  async function openSearchEngineSettings() {
    setSettingsFallback(false);
    try {
      await browser.tabs.create({ url: 'chrome://settings/searchEngines' });
    } catch {
      setSettingsFallback(true);
    }
  }

  function updateJudge<K extends keyof FusionConfig['judge']>(field: K, value: FusionConfig['judge'][K]) {
    setConfig((current) => ({ ...current, judge: { ...current.judge, [field]: value } }));
  }

  const sourceRow = (id: SourceId) => {
    const source = SOURCES[id];
    const settings = config.sources[id] ?? { enabled: false };
    const needsKey = source.requiresKey;
    const missingKey = needsKey && !settings.apiKey;
    const unconfigured = missingKey || (source.requiresBaseUrl && !settings.baseUrl);
    const label = SOURCE_LABELS[id];
    return (
      <tr key={id}>
        <td className="col-name">
          <label className="check">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => (event.target.checked && CONFIRM_ENABLE[id] ? setConfirming(id) : updateSource(id, 'enabled', event.target.checked))}
            />
            <span>{label}</span>
          </label>
          <span className="modes">{source.modes.map((mode) => MODE_LABELS[mode]).join(' · ')}</span>
        </td>
        <td className="col-cred" data-label="API Key / Base URL">
          {id === 'searxng' ? (
            <input type="url" aria-label={`${label} Base URL`} value={settings.baseUrl ?? ''} onChange={(event) => updateSource(id, 'baseUrl', event.target.value)} placeholder="https://searx.example" />
          ) : (
            <input
              type={needsKey || id === 'openalex' ? 'password' : 'text'}
              aria-label={`${label} API Key`}
              value={settings.apiKey ?? ''}
              onChange={(event) => updateSource(id, 'apiKey', event.target.value)}
              placeholder={id === 'openalex' ? '可选 API Key' : needsKey ? 'API Key' : '无需 Key'}
              disabled={!needsKey && id !== 'openalex'}
            />
          )}
          {id === 'searxng' && <input type="password" aria-label={`${label} Bearer Key`} value={settings.apiKey ?? ''} onChange={(event) => updateSource(id, 'apiKey', event.target.value)} placeholder="可选 Bearer Key" />}
        </td>
        <td className="col-weight" data-label="权重">
          <input type="number" aria-label={`${label} 权重`} min="0.1" max="5" step="0.1" value={settings.weight ?? 1} onChange={(event) => updateSource(id, 'weight', Number(event.target.value))} />
        </td>
        <td className="col-status">
          {unconfigured ? (
            <span className="tag tag-warn">
              <TriangleAlertIcon />
              未配置
            </span>
          ) : (
            <span className="tag">{source.requiresBrowser ? '浏览器渲染' : '官方 API'}</span>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div className="options-page">
      <div className="options-bar">
        <div className="options-bar-inner">
          <span className="options-brand">Kiwi Search</span>
          <button className="btn btn-primary" onClick={() => void save()}>
            {saved ? (
              <>
                <CheckIcon />
                已保存
              </>
            ) : (
              '保存设置'
            )}
          </button>
        </div>
      </div>
      <p className="sr-only" role="status">
        {saved ? '设置已保存' : ''}
      </p>

      <div className="options-body">
        <nav className="options-nav" aria-label="设置分区">
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.label}
            </a>
          ))}
        </nav>

        <main className="options-main">
          <header className="options-header">
            <h1>设置</h1>
            <p>配置搜索来源、渲染节奏、模型与本地 MCP 桥。</p>
          </header>

          <section className="section" id="default-search" aria-labelledby="default-search-title">
            <h2 id="default-search-title">默认搜索引擎</h2>
            <p className="note">Chrome 不允许扩展自动更改默认搜索引擎，因此需要手动添加一次 Kiwi Search。</p>
            <p className="note">名称、快捷字词和网址可通过下方按钮复制。在 Chrome 搜索引擎设置中按以下步骤添加并设为默认：</p>
            <div className="field-grid default-search-fields">
              {defaultSearchFields.map(({ id, label, value }) => (
                <div className="field" key={id}>
                  <span id={`default-search-${id}`}>{label}</span>
                  <div className="copy-field">
                    <input value={value} readOnly aria-labelledby={`default-search-${id}`} />
                    <button type="button" className="btn" aria-label={`复制${label}`} onClick={() => void copyDefaultSearchField(id, value)}>
                      {copiedField === id ? (
                        <>
                          <CheckIcon />
                          已复制
                        </>
                      ) : (
                        <>
                          <CopyIcon />
                          复制
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {copyError && (
              <p className="note" role="alert">
                {copyError}
              </p>
            )}
            <ol className="steps">
              <li>点击下方按钮打开 Chrome 搜索引擎设置。</li>
              <li>在“网站搜索”旁点击“添加”。</li>
              <li>填入上方的名称、快捷字词和网址。</li>
              <li>在该条目的 ⋮ 菜单中选择“设为默认”。</li>
            </ol>
            <button type="button" className="btn" onClick={() => void openSearchEngineSettings()}>
              打开 Chrome 搜索引擎设置
            </button>
            {settingsFallback && <p className="note">无法自动打开设置，请将 <code>chrome://settings/searchEngines</code> 复制到地址栏。</p>}
            <p className="note">不改默认也可以在地址栏输入 <code>k</code> 加空格快速使用 Kiwi。</p>
          </section>

          <section className="section" id="sources" aria-labelledby="sources-title">
            <h2 id="sources-title">来源</h2>
            <h3>A 类 · 浏览器渲染</h3>
            <SourceTable>{Object.keys(BROWSER_ENGINES).map((id) => sourceRow(id as SourceId))}</SourceTable>
            <p className="note">
              知乎、小红书要在这个浏览器里登录对应的账号，搜索用的是你自己的登录状态。小红书分国内站和国际站（RedNote），账号和登录状态各自独立，勾选你登录的那一个即可；同一条笔记会按笔记 ID 合并。X 也要先在这个浏览器里登录；X 对自动化使用管得很严，只有你主动打开“X”标签搜索时才会访问它，间隔也更长，但仍有让账号被限制的风险，建议用小号。
            </p>
            <h3>B 类 · 官方 API</h3>
            <SourceTable>{apiSourceIds.map(sourceRow)}</SourceTable>
            <p className="note">
              OpenAlex 不填 Key 也可使用；免费额度为同一 IP 共享约 $0.10/天，注册免费 Key 可提升为约 $1/天。<a href="https://openalex.org/settings/api" target="_blank" rel="noreferrer">申请 OpenAlex API Key</a>
            </p>
          </section>

          <section className="section" id="renderer" aria-labelledby="renderer-title">
            <h2 id="renderer-title">渲染</h2>
            <div className="field-grid">
              <Field label="同一引擎最小间隔（毫秒）"><input type="number" min="0" value={config.renderer.minIntervalMs} onChange={(event) => setConfig({ ...config, renderer: { ...config.renderer, minIntervalMs: Number(event.target.value) } })} /></Field>
              <Field label="工作标签闲置回收（分钟）"><input type="number" min="1" value={config.renderer.workerIdleMinutes} onChange={(event) => setConfig({ ...config, renderer: { ...config.renderer, workerIdleMinutes: Number(event.target.value) } })} /></Field>
            </div>
            <label className="check"><input type="checkbox" checked={config.renderer.focusOnCaptcha} onChange={(event) => setConfig({ ...config, renderer: { ...config.renderer, focusOnCaptcha: event.target.checked } })} />遇到验证码时自动弹出验证窗口（默认关闭：只在搜索页提示，需要时再点“去验证”）</label>
          </section>

          <section className="section" id="judge" aria-labelledby="judge-title">
            <h2 id="judge-title">结果过滤</h2>
            <p className="note">
              用 TypeSafe 的 Jev 决策模型判断每条结果与搜索是否相关、是否为内容农场或搬运内容，据此排序，并把低质量结果折叠到页面底部（可展开查看）。
              启用后会取代下方的重排。
            </p>
            <p className="note">
              隐私：开启并填入 Key 后，搜索词以及每条结果的标题、网址、摘要会发送到 api.typesafe.ai。Key 留空则不会发送任何内容，只使用下面的网站规则。
            </p>
            <label className="check">
              <input type="checkbox" checked={config.intent.enabled} onChange={(event) => setConfig({ ...config, intent: { ...config.intent, enabled: event.target.checked } })} />
              搜索时让决策模型判断要不要同时搜学术、知乎、小红书（需要上面的 Key；没有 Key、出错或超过 3 秒时只搜通用来源）
            </label>
            <div className="field-grid">
              <Field label="提供方">
                <select value={config.judge.provider} onChange={(event) => updateJudge('provider', event.target.value as FusionConfig['judge']['provider'])}>
                  <option value="typesafe">TypeSafe Jev</option>
                  <option value="none">关闭</option>
                </select>
              </Field>
              <Field label="TypeSafe API Key"><input type="password" value={config.judge.apiKey} onChange={(event) => updateJudge('apiKey', event.target.value)} /></Field>
              <Field label="模型"><input value={config.judge.model} onChange={(event) => updateJudge('model', event.target.value)} /></Field>
              <Field label="判定的候选数量"><input type="number" min="5" max="50" value={config.judge.candidates} onChange={(event) => updateJudge('candidates', Number(event.target.value))} /></Field>
              <Field label="隐藏阈值（概率不低于此值时隐藏）"><input type="number" min="0.5" max="0.95" step="0.05" value={config.judge.hideAbove} onChange={(event) => updateJudge('hideAbove', Number(event.target.value))} /></Field>
              <Field label="等待判定的最长时间（毫秒）"><input type="number" min="1000" step="500" value={config.judge.timeoutMs} onChange={(event) => updateJudge('timeoutMs', Number(event.target.value))} /></Field>
              <Field label="自定义过滤规则（每行一条，用自然语言描述要隐藏的结果）" wide>
                <textarea
                  rows={3}
                  value={config.judge.rules.join('\n')}
                  placeholder={'例如：CSDN 上转载自别处的文章\n只有广告和下载按钮的软件站'}
                  onChange={(event) => updateJudge('rules', event.target.value.split('\n'))}
                />
              </Field>
              <Field label="屏蔽的网站（每行一个域名，无需 Key 即可生效）">
                <textarea rows={3} value={config.judge.blockedDomains.join('\n')} placeholder="example.com" onChange={(event) => updateJudge('blockedDomains', event.target.value.split('\n'))} />
              </Field>
              <Field label="优先的网站（每行一个域名，排名提高）">
                <textarea rows={3} value={config.judge.boostedDomains.join('\n')} placeholder="wikipedia.org" onChange={(event) => updateJudge('boostedDomains', event.target.value.split('\n'))} />
              </Field>
            </div>
          </section>

          <section className="section" id="llm" aria-labelledby="llm-title">
            <h2 id="llm-title">LLM</h2>
            <div className="presets" role="group" aria-label="LLM 预设">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="btn"
                  aria-pressed={config.llm.baseUrl === preset.baseUrl}
                  onClick={() => setConfig({ ...config, llm: { ...config.llm, baseUrl: preset.baseUrl, model: preset.model } })}
                >
                  {preset.id}
                </button>
              ))}
            </div>
            <div className="field-grid">
              <Field label="API Base URL"><input value={config.llm.baseUrl} onChange={(event) => setConfig({ ...config, llm: { ...config.llm, baseUrl: event.target.value } })} /></Field>
              <Field label="API Key"><input type="password" value={config.llm.apiKey} onChange={(event) => setConfig({ ...config, llm: { ...config.llm, apiKey: event.target.value } })} /></Field>
              <Field label="模型"><input value={config.llm.model} onChange={(event) => setConfig({ ...config, llm: { ...config.llm, model: event.target.value } })} /></Field>
              <Field label="摘要提供方"><select value={config.summary.provider} onChange={(event) => setConfig({ ...config, summary: { ...config.summary, provider: event.target.value as FusionConfig['summary']['provider'] } })}><option value="api">OpenAI 兼容 API</option><option value="chrome-builtin">Chrome 内置模型</option></select></Field>
              <Field label="摘要引用来源数量"><input type="number" min="1" max="20" value={config.summary.maxSources} onChange={(event) => setConfig({ ...config, summary: { ...config.summary, maxSources: Number(event.target.value) } })} /></Field>
              <Field label="正文读取"><select value={config.summary.contentFetcher} onChange={(event) => setConfig({ ...config, summary: { ...config.summary, contentFetcher: event.target.value as FusionConfig['summary']['contentFetcher'] } })}><option value="direct">直接读取网页</option><option value="jina">Jina Reader</option><option value="none">仅使用摘要片段</option></select></Field>
              <Field label="额外摘要指令" wide><textarea rows={3} value={config.summary.instructions ?? ''} onChange={(event) => setConfig({ ...config, summary: { ...config.summary, instructions: event.target.value } })} /></Field>
            </div>
          </section>

          <section className="section" id="rerank" aria-labelledby="rerank-title">
            <h2 id="rerank-title">重排</h2>
            <p className="note">默认关闭。已启用上面的结果过滤时，不再使用重排。Jina、Cohere 适合没有 TypeSafe Key 时单独使用。</p>
            <div className="field-grid">
              <Field label="提供方"><select value={config.rerank.provider} onChange={(event) => setConfig({ ...config, rerank: { ...config.rerank, provider: event.target.value as FusionConfig['rerank']['provider'] } })}><option value="llm">LLM</option><option value="jina">Jina</option><option value="cohere">Cohere</option><option value="none">不重排</option></select></Field>
              <Field label="API Key（Jina / Cohere）"><input type="password" value={config.rerank.apiKey ?? ''} onChange={(event) => setConfig({ ...config, rerank: { ...config.rerank, apiKey: event.target.value } })} /></Field>
              <Field label="模型"><input value={config.rerank.model ?? ''} onChange={(event) => setConfig({ ...config, rerank: { ...config.rerank, model: event.target.value } })} /></Field>
              <Field label="候选数量"><input type="number" min="1" max="100" value={config.rerank.candidates} onChange={(event) => setConfig({ ...config, rerank: { ...config.rerank, candidates: Number(event.target.value) } })} /></Field>
            </div>
          </section>

          <section className="section" id="mcp" aria-labelledby="mcp-title">
            <h2 id="mcp-title">MCP 桥</h2>
            <label className="check"><input type="checkbox" checked={bridge.enabled} onChange={(event) => setBridge({ ...bridge, enabled: event.target.checked })} />启用本地 MCP 桥</label>
            <div className="field-grid">
              <Field label="本地端口"><input type="number" min="1" max="65535" value={bridge.port} onChange={(event) => setBridge({ ...bridge, port: Number(event.target.value) })} /></Field>
              <Field label="配对令牌"><input type="password" value={bridge.token} onChange={(event) => setBridge({ ...bridge, token: event.target.value })} placeholder="复制 MCP 服务首次启动时生成的 token" /></Field>
            </div>
          </section>
        </main>
      </div>
      {confirming && (
        <ConfirmDialog
          title={`确定要开启${SOURCE_LABELS[confirming]}吗？`}
          confirmLabel="仍然开启"
          onConfirm={() => {
            updateSource(confirming, 'enabled', true);
            setConfirming(null);
          }}
          onCancel={() => setConfirming(null)}
        >
          {CONFIRM_ENABLE[confirming]}
        </ConfirmDialog>
      )}
    </div>
  );
}

/** A modal "are you sure?". Escape, a click on the backdrop and the cancel button all close it without confirming; focus starts on cancel. */
function ConfirmDialog({ title, confirmLabel, onConfirm, onCancel, children }: { title: string; confirmLabel: string; onConfirm: () => void; onCancel: () => void; children: ReactNode }) {
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
            取消
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function SourceTable({ children }: { children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table className="source-table">
        <colgroup>
          <col className="c-name" />
          <col />
          <col className="c-weight" />
          <col className="c-status" />
        </colgroup>
        <thead>
          <tr>
            <th>启用 / 来源</th>
            <th>API Key / Base URL</th>
            <th>权重</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={wide ? 'field field-wide' : 'field'}>
      <span>{label}</span>
      {children}
    </label>
  );
}
