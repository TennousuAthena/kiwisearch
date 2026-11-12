import type { LlmSettings } from '@kiwi-search/core';
import { useState } from 'react';
import { browser } from 'wxt/browser';
import { CheckIcon, CircleAlertIcon } from '@/lib/icons';
import { Field, SecretInput } from './controls';

/** Any OpenAI-compatible service works; these only fill in the address and a sensible model. */
const LLM_PRESETS = [
  { id: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  { id: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
];

type Test = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; ms: number } | { state: 'error'; message: string };

/** The connection to one chat model: address, model, key, a few presets and a test button. */
export function LlmFields({ value, onChange, label }: { value: LlmSettings; onChange: (patch: Partial<LlmSettings>) => void; label: string }) {
  const [test, setTest] = useState<Test>({ state: 'idle' });
  const change = (patch: Partial<LlmSettings>) => {
    setTest({ state: 'idle' });
    onChange(patch);
  };

  async function testConnection() {
    setTest({ state: 'testing' });
    try {
      const reply = (await browser.runtime.sendMessage({ type: 'kiwi:test-llm', llm: value })) as { ok: boolean; ms?: number; error?: string } | undefined;
      setTest(reply?.ok ? { state: 'ok', ms: reply.ms ?? 0 } : { state: 'error', message: reply?.error ?? '没有收到回应' });
    } catch (error) {
      setTest({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <>
      <div className="presets" role="group" aria-label={`${label}：常用服务`}>
        {LLM_PRESETS.map((preset) => (
          <button key={preset.id} type="button" className="btn small" aria-pressed={value.baseUrl === preset.baseUrl} onClick={() => change({ baseUrl: preset.baseUrl, model: preset.model })}>
            {preset.id}
          </button>
        ))}
      </div>
      <div className="field-grid">
        <Field label="API 地址">
          <input value={value.baseUrl} onChange={(event) => change({ baseUrl: event.target.value })} />
        </Field>
        <Field label="模型">
          <input value={value.model} onChange={(event) => change({ model: event.target.value })} />
        </Field>
        <Field label="API Key" wide>
          <SecretInput label={`${label} API Key`} value={value.apiKey} placeholder="粘贴你自己的 Key（本机服务可留空）" onChange={(apiKey) => change({ apiKey })} />
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
  );
}
