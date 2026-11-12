import type { FusionConfig, SourceId } from '@kiwi-search/core';
import { SOURCE_INFO } from '@/lib/sourceCatalog';
import { SOURCE_LABELS } from '@/lib/sourceMeta';
import type { BridgeSettings } from '@/lib/settings';
import { StartSection } from './StartSection';
import type { SourceHealthMap } from '@/lib/sourceHealth';
import { Field, NumberField, SecretInput, SwitchRow } from './controls';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: FusionConfig;
  bridge: BridgeSettings;
  health: SourceHealthMap;
  onChange: (update: (config: FusionConfig) => FusionConfig) => void;
  onBridge: (patch: Partial<BridgeSettings>) => void;
  onWeight: (id: SourceId, weight: number) => void;
  onReset: () => void;
}

/** Everything that has a sensible default and that most people never touch, folded away. */
export function AdvancedSection({ open, onOpenChange, config, bridge, health, onChange, onBridge, onWeight, onReset }: Props) {
  const setRenderer = (patch: Partial<FusionConfig['renderer']>) => onChange((c) => ({ ...c, renderer: { ...c.renderer, ...patch } }));
  const setJudge = (patch: Partial<FusionConfig['judge']>) => onChange((c) => ({ ...c, judge: { ...c.judge, ...patch } }));
  const setIntent = (patch: Partial<FusionConfig['intent']>) => onChange((c) => ({ ...c, intent: { ...c.intent, ...patch } }));
  const setSummary = (patch: Partial<FusionConfig['summary']>) => onChange((c) => ({ ...c, summary: { ...c.summary, ...patch } }));
  const enabled = (Object.keys(SOURCE_INFO) as SourceId[]).filter((id) => config.sources[id]?.enabled);
  return (
    <section className="section" id="advanced" aria-labelledby="advanced-title">
      <details className="advanced" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
        <summary>
          <h2 id="advanced-title">高级</h2>
          <span>请求节奏、权重、阈值、MCP 桥，以及重新打开使用引导。默认值已经够用。</span>
        </summary>

        <div className="adv-block">
          <h3>每个来源取多少条</h3>
          <div className="field-grid">
            <NumberField label="网页和学术（每个来源）" value={config.perSourceCount} min={1} max={50} onChange={(perSourceCount) => onChange((c) => ({ ...c, perSourceCount }))} />
            <NumberField label="图片" value={config.imageCount} min={1} max={200} onChange={(imageCount) => onChange((c) => ({ ...c, imageCount }))} />
            <NumberField label="视频" value={config.videoCount} min={1} max={50} onChange={(videoCount) => onChange((c) => ({ ...c, videoCount }))} />
            <NumberField label="小红书笔记" value={config.noteCount} min={1} max={50} onChange={(noteCount) => onChange((c) => ({ ...c, noteCount }))} />
            <NumberField label="单个来源最长等待（毫秒）" value={config.sourceTimeoutMs} min={2000} step={1000} onChange={(sourceTimeoutMs) => onChange((c) => ({ ...c, sourceTimeoutMs }))} />
          </div>
        </div>

        <div className="adv-block">
          <h3>浏览器渲染的节奏</h3>
          <div className="field-grid">
            <NumberField label="同一引擎两次请求的最小间隔（毫秒）" hint="调大可以减少被搜索引擎要求验证的机会。" value={config.renderer.minIntervalMs} min={0} step={500} onChange={(minIntervalMs) => setRenderer({ minIntervalMs })} />
            <NumberField label="工作标签闲置多久后回收（分钟）" value={config.renderer.workerIdleMinutes} min={1} onChange={(workerIdleMinutes) => setRenderer({ workerIdleMinutes })} />
          </div>
          <SwitchRow checked={config.renderer.focusOnCaptcha} onChange={(focusOnCaptcha) => setRenderer({ focusOnCaptcha })} title="遇到验证码时自动弹出验证窗口" hint="默认关闭：只在搜索页提示，需要时再点“去验证”。登录墙永远不会自动弹出。" />
        </div>

        <div className="adv-block">
          <h3>来源权重</h3>
          <p className="note">融合排名时，权重高的来源的名次更重要。默认都是 1。</p>
          <div className="field-grid weights">
            {enabled.map((id) => (
              <NumberField key={id} label={SOURCE_LABELS[id]} value={config.sources[id]?.weight ?? 1} min={0.1} max={5} step={0.1} onChange={(weight) => onWeight(id, weight)} />
            ))}
          </div>
        </div>

        <div className="adv-block">
          <h3>决策模型的参数</h3>
          <div className="field-grid">
            {config.judge.provider === 'typesafe' && (
              <Field label="TypeSafe 模型名">
                <input value={config.judge.model} onChange={(event) => setJudge({ model: event.target.value })} />
              </Field>
            )}
            <NumberField label="判定的候选数量" value={config.judge.candidates} min={5} max={50} onChange={(candidates) => setJudge({ candidates })} />
            <NumberField label="隐藏阈值" hint="判为低质量的把握不低于这个值才隐藏。" value={config.judge.hideAbove} min={0.5} max={0.95} step={0.05} onChange={(hideAbove) => setJudge({ hideAbove })} />
            <NumberField label="等待判定的最长时间（毫秒）" hint="聊天模型比 TypeSafe 慢，默认 12 秒；只是上限，模型快就不会等满。" value={config.judge.timeoutMs} min={1000} step={500} onChange={(timeoutMs) => setJudge({ timeoutMs })} />
            <NumberField label="自动补搜的把握阈值" hint="决策模型觉得需要同时搜学术、知乎等的把握不低于这个值才补搜。" value={config.intent.threshold} min={0.3} max={0.95} step={0.05} onChange={(threshold) => setIntent({ threshold })} />
            <NumberField label="等待补搜判断的最长时间（毫秒）" value={config.intent.timeoutMs} min={500} step={500} onChange={(timeoutMs) => setIntent({ timeoutMs })} />
            <NumberField label="自动切换标签的把握阈值" hint="想找图片、视频或论文的把握不低于这个值，且页面上还没有结果时，直接切到对应标签；低于它只给一行提示。" value={config.intent.switchThreshold} min={0.5} max={0.99} step={0.05} onChange={(switchThreshold) => setIntent({ switchThreshold })} />
          </div>
          <SwitchRow checked={config.intent.autoSwitch} onChange={(autoSwitch) => setIntent({ autoSwitch })} title="把握很大时自动切换标签" hint="关闭后只在结果上方给一行提示，由你决定切不切。" />
        </div>

        <div className="adv-block">
          <h3>智能学术搜索的参数</h3>
          <div className="field-grid">
            <NumberField label="最多点名几篇论文" value={config.academic.landmarks} min={1} max={10} onChange={(landmarks) => onChange((c) => ({ ...c, academic: { ...c.academic, landmarks } }))} />
            <NumberField label="最长等待（毫秒）" hint="模型和文献库核对加起来超过这个时间，就放弃智能部分，只用普通搜索。" value={config.academic.timeoutMs} min={3000} step={1000} onChange={(timeoutMs) => onChange((c) => ({ ...c, academic: { ...c.academic, timeoutMs } }))} />
          </div>
        </div>

        <div className="adv-block">
          <h3>AI 概览的参数</h3>
          <div className="field-grid">
            <NumberField label="引用的来源数量" value={config.summary.maxSources} min={1} max={20} onChange={(maxSources) => setSummary({ maxSources })} />
            <Field label="读取正文的方式">
              <select value={config.summary.contentFetcher} onChange={(event) => setSummary({ contentFetcher: event.target.value as FusionConfig['summary']['contentFetcher'] })}>
                <option value="direct">直接读取网页</option>
                <option value="jina">Jina Reader</option>
                <option value="none">只用摘要片段</option>
              </select>
            </Field>
            <Field label="额外的概览指令" wide>
              <textarea rows={3} value={config.summary.instructions ?? ''} placeholder="例如：用英文回答；先给结论" onChange={(event) => setSummary({ instructions: event.target.value })} />
            </Field>
          </div>
        </div>

        <div className="adv-block">
          <h3>MCP 桥</h3>
          <p className="note">让本机的 MCP 服务（给 Claude 等 Agent 用）通过这个扩展搜索。令牌在 MCP 服务第一次启动时生成，在终端运行 <code>cat ~/.kiwi-search/token</code> 就能看到。</p>
          <SwitchRow checked={bridge.enabled} onChange={(enabled) => onBridge({ enabled })} title="启用本地 MCP 桥" />
          <div className="field-grid">
            <NumberField label="本地端口" value={bridge.port} min={1} max={65535} onChange={(port) => onBridge({ port })} />
            <Field label="配对令牌">
              <SecretInput label="配对令牌" value={bridge.token} placeholder="粘贴令牌" onChange={(token) => onBridge({ token: token.trim() })} />
            </Field>
          </div>
        </div>

        <div className="adv-block">
          <h3>使用引导</h3>
          <details className="inline-details">
            <summary>默认搜索引擎、登录平台</summary>
            <StartSection config={config} health={health} />
          </details>
        </div>

        <div className="adv-block">
          <h3>恢复默认</h3>
          <p className="note">把所有开关和参数改回默认值。你填的 Key 和地址会保留。</p>
          <button type="button" className="btn" onClick={onReset}>
            恢复默认设置…
          </button>
        </div>
      </details>
    </section>
  );
}
