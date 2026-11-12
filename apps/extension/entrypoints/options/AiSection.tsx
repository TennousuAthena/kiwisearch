import { decisionModelUsable, llmUsable, systemOneUsable, type FusionConfig, type JudgeProvider } from '@kiwi-search/core';
import { DecisionFields } from './DecisionFields';
import { Field, RuleList, SecretInput, Segmented, SwitchRow } from './controls';
import { LlmFields } from './LlmFields';

interface Props {
  config: FusionConfig;
  onChange: (update: (config: FusionConfig) => FusionConfig) => void;
}

const PROVIDERS: { value: JudgeProvider; label: string }[] = [
  { value: 'systemone', label: '专用决策模型（推荐）' },
  { value: 'llm', label: '只用我的 AI 模型' },
  { value: 'none', label: '不用' },
];

/** The host of a service address, for saying where the questions go. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function AiSection({ config, onChange }: Props) {
  const modelReady = llmUsable(config.llm);
  const decisionReady = decisionModelUsable(config);
  const { judge } = config;
  const provider = judge.provider;
  const dedicatedReady = systemOneUsable(judge);
  const summaryOn = config.summary.enabled;
  // The chat model is the main decision model (`llm`), or the stand-in behind a dedicated one.
  const chatModelInUse = provider === 'llm' || (provider === 'systemone' && judge.fallbackToLlm);

  const setJudge = (patch: Partial<FusionConfig['judge']>) => onChange((c) => ({ ...c, judge: { ...c.judge, ...patch } }));
  const setJudgeLlm = (patch: Partial<FusionConfig['judge']['llm']>) => onChange((c) => ({ ...c, judge: { ...c.judge, llm: { ...c.judge.llm, ...patch } } }));
  const setLlm = (patch: Partial<FusionConfig['llm']>) => onChange((c) => ({ ...c, llm: { ...c.llm, ...patch } }));
  const setSummary = (patch: Partial<FusionConfig['summary']>) => onChange((c) => ({ ...c, summary: { ...c.summary, ...patch } }));
  const setRerank = (patch: Partial<FusionConfig['rerank']>) => onChange((c) => ({ ...c, rerank: { ...c.rerank, ...patch } }));

  return (
    <section className="section" id="ai" aria-labelledby="ai-title">
      <h2 id="ai-title">AI 功能</h2>
      <p className="lead">都是可选的，用的都是你自己的服务和 Key。不填，搜索照常工作。</p>

      <div className="card">
        <strong className="card-title">AI 模型</strong>
        <p className="card-lead">你自己的大模型服务，任何 OpenAI 兼容的都行：DeepSeek、OpenAI、OpenRouter、本机 Ollama……AI 概览和智能学术搜索用它；决策模型没配好时也由它代替。</p>
        <div className="card-body">
          <LlmFields value={config.llm} onChange={setLlm} label="AI 模型" />
        </div>
      </div>

      <div className="card">
        <SwitchRow checked={summaryOn} onChange={(enabled) => setSummary({ enabled })} title="AI 概览" hint="在搜索结果旁，用你的模型读完最相关的几条结果，写一段带 [n] 引用的概览。" />
        {summaryOn && (
          <div className="card-body">
            <Field label="模型来源">
              <select value={config.summary.provider} onChange={(event) => setSummary({ provider: event.target.value as FusionConfig['summary']['provider'] })}>
                <option value="api">上面的 AI 模型</option>
                <option value="chrome-builtin">Chrome 内置模型（免 Key，只在新标签页里可用）</option>
              </select>
            </Field>
          </div>
        )}
      </div>

      <div className="card">
        <SwitchRow
          checked={config.academic.smart}
          disabled={!modelReady}
          onChange={(smart) => onChange((c) => ({ ...c, academic: { ...c.academic, smart } }))}
          title="智能学术搜索"
          hint={
            modelReady
              ? '搜“学术”时，让你的 AI 模型先理解你要找什么：写出检索式，点名最可能要找的论文（比如搜 transformer，把《Attention Is All You Need》排在最前）。点名的每一篇都会在文献库里核对，查不到的直接丢掉，不会凭空出现。多花 2 到 4 秒。'
              : '需要先配置好上面的 AI 模型。'
          }
        />
      </div>

      <div className="card">
        <strong className="card-title">决策模型</strong>
        <p className="card-lead">一个专做判断的小模型，回答两类小问题：每条结果是否相关、是不是内容农场或搬运内容（据此排序，把低质量的折叠到页面底部）；你想搜什么（要不要同时搜知乎、小红书、公众号，是不是想找图片、视频或论文）。专用的比聊天模型快得多，推荐配一个。</p>
        <div className="card-body">
          <Segmented label="决策模型用哪个" value={provider} options={PROVIDERS} onChange={(next) => setJudge({ provider: next })} />

          {provider === 'systemone' && !dedicatedReady && (
            <p className="notice" role="status">
              {judge.fallbackToLlm && modelReady
                ? '还没配专用决策模型，现在由你的 AI 模型代替，每次判断要多等几秒。配一个专用的会快得多（几百毫秒）。'
                : '还没配专用决策模型，决策功能暂时没有启用。'}
            </p>
          )}

          {provider === 'systemone' && <DecisionFields judge={judge} onChange={setJudge} />}

          {provider === 'systemone' && (
            <SwitchRow
              checked={judge.fallbackToLlm}
              onChange={(fallbackToLlm) => setJudge({ fallbackToLlm })}
              title="没配好或出错时，用我的 AI 模型代替"
              hint="比如网络出口被服务商拒绝（HTTP 451）、Key 失效。代替时慢几秒，但功能不会中断。"
            />
          )}

          {chatModelInUse && (
            <>
              {provider === 'systemone' && <p className="card-lead">代替时用的聊天模型</p>}
              <SwitchRow
                checked={judge.llmShared}
                onChange={(llmShared) => setJudge({ llmShared })}
                title="和上面的 AI 模型用同一个"
                hint={judge.llmShared ? '决策是小问题、要快：可以另选一个响应快的小模型。会“思考”的模型每次要多等几秒。' : '用下面单独配置的模型，只做决策。'}
              />
              {!judge.llmShared && <LlmFields value={judge.llm} onChange={setJudgeLlm} label="决策模型" />}
              {judge.llmShared && !modelReady && <p className="note">需要先配置好上面的 AI 模型。</p>}
            </>
          )}

          {provider !== 'none' && (
            <p className="note">
              隐私：开启后，每次搜索会把搜索词，以及每条结果的标题、网址和摘要发送给{' '}
              {provider === 'systemone' && dedicatedReady
                ? `${hostOf(judge.endpoint)}（决策模型）${judge.fallbackToLlm ? '；它出错时改发给你的 AI 模型服务' : ''}`
                : '你配置的 AI 模型服务'}
              。没配好时不会发送任何内容，只使用“屏蔽与偏好”里的网站规则。
            </p>
          )}

          {provider !== 'none' && (
            <>
              <SwitchRow
                checked={config.intent.enabled}
                disabled={!decisionReady}
                onChange={(enabled) => onChange((c) => ({ ...c, intent: { ...c.intent, enabled } }))}
                title="自动判断你想搜什么"
                hint={
                  decisionReady
                    ? '搜“全部”时，让决策模型判断要不要同时搜学术、知乎、小红书、公众号，以及你是不是想找图片、视频或论文（把握很大时直接切到对应标签）。判断来不及或出错，就只搜通用来源。'
                    : '需要先把上面的决策模型配置好。'
                }
              />
              <RuleList
                label="自定义过滤规则"
                values={judge.rules}
                onChange={(rules) => setJudge({ rules })}
                placeholder="用一句话描述要隐藏的结果，例如：CSDN 上转载自别处的文章，回车添加"
              />
            </>
          )}

          {!decisionReady && (
            <details className="inline-details">
              <summary>没有决策模型？可以用重排作为备选</summary>
              <p className="note">重排只调整顺序，不会隐藏结果，也不会补搜平台。配好决策模型后这里不再起作用。</p>
              <div className="field-grid">
                <Field label="重排方式">
                  <select value={config.rerank.provider} onChange={(event) => setRerank({ provider: event.target.value as FusionConfig['rerank']['provider'] })}>
                    <option value="none">不重排</option>
                    <option value="llm">用上面的 AI 模型</option>
                    <option value="jina">Jina</option>
                    <option value="cohere">Cohere</option>
                  </select>
                </Field>
                {(config.rerank.provider === 'jina' || config.rerank.provider === 'cohere') && (
                  <Field label={`${config.rerank.provider === 'jina' ? 'Jina' : 'Cohere'} API Key`}>
                    <SecretInput label="重排 API Key" value={config.rerank.apiKey ?? ''} onChange={(apiKey) => setRerank({ apiKey })} />
                  </Field>
                )}
              </div>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
