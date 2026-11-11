import type { FusionConfig } from '@kiwi-search/core';
import { useState } from 'react';
import { browser } from 'wxt/browser';
import { CheckIcon, CircleAlertIcon } from '@/lib/icons';
import { Field, RuleList, SecretInput, SwitchRow } from './controls';

const LLM_PRESETS = [
  { id: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  { id: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
];

interface Props {
  config: FusionConfig;
  onChange: (update: (config: FusionConfig) => FusionConfig) => void;
}

type Test = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; ms: number } | { state: 'error'; message: string };

export function AiSection({ config, onChange }: Props) {
  const [test, setTest] = useState<Test>({ state: 'idle' });
  const jevOn = config.judge.provider !== 'none';
  const jevReady = jevOn && !!config.judge.apiKey;
  const summaryOn = config.summary.enabled;

  const setJudge = (patch: Partial<FusionConfig['judge']>) => onChange((c) => ({ ...c, judge: { ...c.judge, ...patch } }));
  const setLlm = (patch: Partial<FusionConfig['llm']>) => {
    setTest({ state: 'idle' });
    onChange((c) => ({ ...c, llm: { ...c.llm, ...patch } }));
  };
  const setSummary = (patch: Partial<FusionConfig['summary']>) => onChange((c) => ({ ...c, summary: { ...c.summary, ...patch } }));
  const setRerank = (patch: Partial<FusionConfig['rerank']>) => onChange((c) => ({ ...c, rerank: { ...c.rerank, ...patch } }));

  async function testConnection() {
    setTest({ state: 'testing' });
    try {
      const reply = (await browser.runtime.sendMessage({ type: 'kiwi:test-llm', llm: config.llm })) as { ok: boolean; ms?: number; error?: string } | undefined;
      setTest(reply?.ok ? { state: 'ok', ms: reply.ms ?? 0 } : { state: 'error', message: reply?.error ?? '没有收到回应' });
    } catch (error) {
      setTest({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <section className="section" id="ai" aria-labelledby="ai-title">
      <h2 id="ai-title">AI 功能</h2>
      <p className="lead">两样都是可选的，用的都是你自己的 Key。不填，搜索照常工作。</p>

      <div className="card">
        <SwitchRow
          checked={jevOn}
          onChange={(next) => setJudge({ provider: next ? 'typesafe' : 'none' })}
          title="智能过滤"
          hint="用 TypeSafe 的 Jev 决策模型判断每条结果是否相关、是不是内容农场或搬运内容：据此排序，把低质量的折叠到页面底部（可展开查看）。"
        />
        {jevOn && (
          <div className="card-body">
            <Field label="TypeSafe API Key" hint={jevReady ? undefined : '没有 Key 时不会发送任何内容，只使用“屏蔽与偏好”里的网站规则。'}>
              <SecretInput label="TypeSafe API Key" value={config.judge.apiKey} placeholder="粘贴你自己的 Key" onChange={(apiKey) => setJudge({ apiKey })} />
            </Field>
            <p className="note">隐私：填入 Key 后，搜索词以及每条结果的标题、网址、摘要会发送到 api.typesafe.ai。</p>
            <SwitchRow
              checked={config.intent.enabled}
              disabled={!jevReady}
              onChange={(enabled) => onChange((c) => ({ ...c, intent: { ...c.intent, enabled } }))}
              title="自动判断你想搜什么"
              hint={jevReady ? '搜“全部”时，让决策模型判断要不要同时搜学术、知乎、小红书、公众号，以及你是不是想找图片、视频或论文（把握很大时直接切到对应标签）。判断来不及或出错，就只搜通用来源。' : '需要先填上面的 Key。'}
            />
            <RuleList
              label="自定义过滤规则"
              values={config.judge.rules}
              onChange={(rules) => setJudge({ rules })}
              placeholder="用一句话描述要隐藏的结果，例如：CSDN 上转载自别处的文章，回车添加"
            />
            {!jevReady && (
              <details className="inline-details">
                <summary>没有 TypeSafe Key？可以用重排作为备选</summary>
                <p className="note">重排只调整顺序，不会隐藏结果。填了 TypeSafe Key 后这里不再起作用。</p>
                <div className="field-grid">
                  <Field label="重排方式">
                    <select value={config.rerank.provider} onChange={(event) => setRerank({ provider: event.target.value as FusionConfig['rerank']['provider'] })}>
                      <option value="none">不重排</option>
                      <option value="llm">用下面的 AI 模型</option>
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
        )}
      </div>

      <div className="card">
        <SwitchRow checked={summaryOn} onChange={(enabled) => setSummary({ enabled })} title="AI 概览" hint="在搜索结果旁，用你的模型读完最相关的几条结果，写一段带 [n] 引用的概览。" />
        {summaryOn && (
          <div className="card-body">
            <Field label="模型来源">
              <select value={config.summary.provider} onChange={(event) => setSummary({ provider: event.target.value as FusionConfig['summary']['provider'] })}>
                <option value="api">OpenAI 兼容的 API（DeepSeek、OpenAI、本机 Ollama 等）</option>
                <option value="chrome-builtin">Chrome 内置模型（免 Key，只在新标签页里可用）</option>
              </select>
            </Field>
            {config.summary.provider === 'api' && (
              <>
                <div className="presets" role="group" aria-label="常用服务">
                  {LLM_PRESETS.map((preset) => (
                    <button key={preset.id} type="button" className="btn small" aria-pressed={config.llm.baseUrl === preset.baseUrl} onClick={() => setLlm({ baseUrl: preset.baseUrl, model: preset.model })}>
                      {preset.id}
                    </button>
                  ))}
                </div>
                <div className="field-grid">
                  <Field label="API 地址">
                    <input value={config.llm.baseUrl} onChange={(event) => setLlm({ baseUrl: event.target.value })} />
                  </Field>
                  <Field label="模型">
                    <input value={config.llm.model} onChange={(event) => setLlm({ model: event.target.value })} />
                  </Field>
                  <Field label="API Key" wide>
                    <SecretInput label="LLM API Key" value={config.llm.apiKey} placeholder="粘贴你自己的 Key（本机服务可留空）" onChange={(apiKey) => setLlm({ apiKey })} />
                  </Field>
                </div>
                <div className="test-row">
                  <button type="button" className="btn" disabled={test.state === 'testing'} onClick={() => void testConnection()}>
                    {test.state === 'testing' ? '测试中…' : '测试连接'}
                  </button>
                  <span role="status" className={test.state === 'ok' ? 'test-result ok' : test.state === 'error' ? 'test-result bad' : 'test-result'}>
                    {test.state === 'ok' && (
                      <>
                        <CheckIcon /> 连通了（{(test.ms / 1000).toFixed(1)} 秒）
                      </>
                    )}
                    {test.state === 'error' && (
                      <>
                        <CircleAlertIcon /> {test.message}
                      </>
                    )}
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
