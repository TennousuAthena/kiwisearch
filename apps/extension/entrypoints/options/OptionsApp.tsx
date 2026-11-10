import { BROWSER_ENGINES, DEFAULT_CONFIG, SOURCES, type FusionConfig, type SourceId } from '@fusion-search/core';
import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_BRIDGE, loadBridge, loadConfig, saveBridge, saveConfig, type BridgeSettings } from '@/lib/settings';
import { SOURCE_META } from '@/lib/sourceMeta';

const apiSourceIds: SourceId[] = ['openalex', 'exa', 'deepseek', 'brave', 'searxng'];
const presets = [
  { id: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  { id: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
];

export default function OptionsApp() {
  const [config, setConfig] = useState<FusionConfig>(() => structuredClone(DEFAULT_CONFIG));
  const [bridge, setBridge] = useState<BridgeSettings>(DEFAULT_BRIDGE);
  const [saved, setSaved] = useState(false);

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

  const sourceRow = (id: SourceId) => {
    const source = SOURCES[id];
    const settings = config.sources[id] ?? { enabled: false };
    const needsKey = source.requiresKey;
    const missingKey = needsKey && !settings.apiKey;
    return (
      <tr key={id}>
        <td>
          <label className="check">
            <input type="checkbox" checked={settings.enabled} onChange={(event) => updateSource(id, 'enabled', event.target.checked)} />
            <span>{SOURCE_META[id].label}</span>
          </label>
        </td>
        <td>
          {id === 'searxng' ? (
            <input type="url" value={settings.baseUrl ?? ''} onChange={(event) => updateSource(id, 'baseUrl', event.target.value)} placeholder="https://searx.example" />
          ) : (
            <input
              type={needsKey || id === 'openalex' ? 'password' : 'text'}
              value={settings.apiKey ?? ''}
              onChange={(event) => updateSource(id, 'apiKey', event.target.value)}
              placeholder={id === 'openalex' ? '可选 API Key' : needsKey ? 'API Key' : '无需 Key'}
              disabled={!needsKey && id !== 'openalex'}
            />
          )}
          {id === 'searxng' && <input type="password" value={settings.apiKey ?? ''} onChange={(event) => updateSource(id, 'apiKey', event.target.value)} placeholder="可选 Bearer Key" />}
        </td>
        <td>
          <input type="number" min="0.1" max="5" step="0.1" value={settings.weight ?? 1} onChange={(event) => updateSource(id, 'weight', Number(event.target.value))} />
        </td>
        <td>{missingKey || (id === 'searxng' && !settings.baseUrl) ? <span className="not-configured">未配置</span> : source.requiresBrowser ? '浏览器渲染' : '官方 API'}</td>
      </tr>
    );
  };

  return (
    <div className="options-page">
      <header>
        <div>
          <p className="eyebrow">FUSION SEARCH</p>
          <h1>设置</h1>
          <p className="muted">配置搜索来源、渲染节奏、模型与本地 MCP 桥。</p>
        </div>
        <button className="save" onClick={() => void save()}>{saved ? '已保存' : '保存设置'}</button>
      </header>

      <section>
        <h2>来源</h2>
        <h3>A 类 · 浏览器渲染</h3>
        <SourceTable>{Object.keys(BROWSER_ENGINES).map((id) => sourceRow(id as SourceId))}</SourceTable>
        <h3>B 类 · 官方 API</h3>
        <SourceTable>{apiSourceIds.map(sourceRow)}</SourceTable>
        <p className="note">
          OpenAlex 不填 Key 也可使用；免费额度为同一 IP 共享约 $0.10/天，注册免费 Key 可提升为约 $1/天。<a href="https://openalex.org/settings/api" target="_blank" rel="noreferrer">申请 OpenAlex API Key</a>
        </p>
      </section>

      <section>
        <h2>渲染</h2>
        <div className="field-grid">
          <Field label="同一引擎最小间隔（毫秒）"><input type="number" min="0" value={config.renderer.minIntervalMs} onChange={(event) => setConfig({ ...config, renderer: { ...config.renderer, minIntervalMs: Number(event.target.value) } })} /></Field>
          <Field label="工作标签闲置回收（分钟）"><input type="number" min="1" value={config.renderer.workerIdleMinutes} onChange={(event) => setConfig({ ...config, renderer: { ...config.renderer, workerIdleMinutes: Number(event.target.value) } })} /></Field>
          <label className="check"><input type="checkbox" checked={config.renderer.focusOnCaptcha} onChange={(event) => setConfig({ ...config, renderer: { ...config.renderer, focusOnCaptcha: event.target.checked } })} />遇到验证码时切到前台</label>
        </div>
      </section>

      <section>
        <h2>LLM</h2>
        <div className="presets">{presets.map((preset) => <button key={preset.id} onClick={() => setConfig({ ...config, llm: { ...config.llm, baseUrl: preset.baseUrl, model: preset.model } })}>{preset.id}</button>)}</div>
        <div className="field-grid">
          <Field label="API Base URL"><input value={config.llm.baseUrl} onChange={(event) => setConfig({ ...config, llm: { ...config.llm, baseUrl: event.target.value } })} /></Field>
          <Field label="API Key"><input type="password" value={config.llm.apiKey} onChange={(event) => setConfig({ ...config, llm: { ...config.llm, apiKey: event.target.value } })} /></Field>
          <Field label="模型"><input value={config.llm.model} onChange={(event) => setConfig({ ...config, llm: { ...config.llm, model: event.target.value } })} /></Field>
          <Field label="摘要提供方"><select value={config.summary.provider} onChange={(event) => setConfig({ ...config, summary: { ...config.summary, provider: event.target.value as FusionConfig['summary']['provider'] } })}><option value="api">OpenAI 兼容 API</option><option value="chrome-builtin">Chrome 内置模型</option></select></Field>
          <Field label="摘要引用来源数量"><input type="number" min="1" max="20" value={config.summary.maxSources} onChange={(event) => setConfig({ ...config, summary: { ...config.summary, maxSources: Number(event.target.value) } })} /></Field>
          <Field label="正文读取"><select value={config.summary.contentFetcher} onChange={(event) => setConfig({ ...config, summary: { ...config.summary, contentFetcher: event.target.value as FusionConfig['summary']['contentFetcher'] } })}><option value="direct">直接读取网页</option><option value="jina">Jina Reader</option><option value="none">仅使用摘要片段</option></select></Field>
          <Field label="额外摘要指令"><textarea rows={3} value={config.summary.instructions ?? ''} onChange={(event) => setConfig({ ...config, summary: { ...config.summary, instructions: event.target.value } })} /></Field>
        </div>
      </section>

      <section>
        <h2>重排</h2>
        <div className="field-grid">
          <Field label="提供方"><select value={config.rerank.provider} onChange={(event) => setConfig({ ...config, rerank: { ...config.rerank, provider: event.target.value as FusionConfig['rerank']['provider'] } })}><option value="llm">LLM</option><option value="jina">Jina</option><option value="cohere">Cohere</option><option value="none">不重排</option></select></Field>
          <Field label="API Key（Jina / Cohere）"><input type="password" value={config.rerank.apiKey ?? ''} onChange={(event) => setConfig({ ...config, rerank: { ...config.rerank, apiKey: event.target.value } })} /></Field>
          <Field label="模型"><input value={config.rerank.model ?? ''} onChange={(event) => setConfig({ ...config, rerank: { ...config.rerank, model: event.target.value } })} /></Field>
          <Field label="候选数量"><input type="number" min="1" max="100" value={config.rerank.candidates} onChange={(event) => setConfig({ ...config, rerank: { ...config.rerank, candidates: Number(event.target.value) } })} /></Field>
        </div>
      </section>

      <section>
        <h2>MCP 桥</h2>
        <div className="field-grid">
          <label className="check"><input type="checkbox" checked={bridge.enabled} onChange={(event) => setBridge({ ...bridge, enabled: event.target.checked })} />启用本地 MCP 桥</label>
          <Field label="本地端口"><input type="number" min="1" max="65535" value={bridge.port} onChange={(event) => setBridge({ ...bridge, port: Number(event.target.value) })} /></Field>
          <Field label="配对令牌"><input type="password" value={bridge.token} onChange={(event) => setBridge({ ...bridge, token: event.target.value })} placeholder="复制 MCP 服务首次启动时生成的 token" /></Field>
        </div>
      </section>
      <button className="save bottom-save" onClick={() => void save()}>{saved ? '已保存' : '保存设置'}</button>
    </div>
  );
}

function SourceTable({ children }: { children: ReactNode }) {
  return <div className="table-scroll"><table><thead><tr><th>启用 / 来源</th><th>API Key / Base URL</th><th>权重</th><th>状态</th></tr></thead><tbody>{children}</tbody></table></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
