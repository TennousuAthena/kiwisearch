import type { LlmSettings } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { Field, SecretInput } from './controls';
import { TestRow, type TestReply } from './TestRow';

/** Any OpenAI-compatible service works; these only fill in the address and a sensible model. */
const LLM_PRESETS = [
  { id: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  { id: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
];

/** The connection to one chat model: address, model, key, a few presets and a test button. */
export function LlmFields({ value, onChange, label }: { value: LlmSettings; onChange: (patch: Partial<LlmSettings>) => void; label: string }) {
  return (
    <>
      <div className="presets" role="group" aria-label={`${label}：常用服务`}>
        {LLM_PRESETS.map((preset) => (
          <button key={preset.id} type="button" className="btn small" aria-pressed={value.baseUrl === preset.baseUrl} onClick={() => onChange({ baseUrl: preset.baseUrl, model: preset.model })}>
            {preset.id}
          </button>
        ))}
      </div>
      <div className="field-grid">
        <Field label="API 地址">
          <input value={value.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} />
        </Field>
        <Field label="模型">
          <input value={value.model} onChange={(event) => onChange({ model: event.target.value })} />
        </Field>
        <Field label="API Key" wide>
          <SecretInput label={`${label} API Key`} value={value.apiKey} placeholder="粘贴你自己的 Key（本机服务可留空）" onChange={(apiKey) => onChange({ apiKey })} />
        </Field>
      </div>
      <TestRow watch={JSON.stringify(value)} run={() => browser.runtime.sendMessage({ type: 'kiwi:test-llm', llm: value }) as Promise<TestReply | undefined>} />
    </>
  );
}
