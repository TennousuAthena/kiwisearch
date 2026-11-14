import type { LlmSettings } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { t } from '@kiwi-search/app/i18n';
import { Field, SecretInput } from './controls';
import { TestRow, type TestReply } from './TestRow';

/** Any OpenAI-compatible service works; these only fill in the address and a sensible model. */
const LLM_PRESETS = [
  { id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
] as const;

/** The connection to one chat model: address, model, key, a few presets and a test button. */
export function LlmFields({ value, onChange, label }: { value: LlmSettings; onChange: (patch: Partial<LlmSettings>) => void; label: string }) {
  return (
    <>
      <div className="presets" role="group" aria-label={t('options.llm.presetsLabel', { label })}>
        {LLM_PRESETS.map((preset) => (
          <button key={preset.id} type="button" className="btn small" aria-pressed={value.baseUrl === preset.baseUrl} onClick={() => onChange({ baseUrl: preset.baseUrl, model: preset.model })}>
            {t(`preset.llm.${preset.id}`)}
          </button>
        ))}
      </div>
      <div className="field-grid">
        <Field label={t('options.llm.baseUrlLabel')}>
          <input value={value.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} />
        </Field>
        <Field label={t('options.llm.modelLabel')}>
          <input value={value.model} onChange={(event) => onChange({ model: event.target.value })} />
        </Field>
        <Field label="API Key" wide>
          <SecretInput label={t('options.llm.keyAria', { label })} value={value.apiKey} placeholder={t('options.llm.keyPlaceholder')} onChange={(apiKey) => onChange({ apiKey })} />
        </Field>
      </div>
      <TestRow watch={JSON.stringify(value)} run={() => browser.runtime.sendMessage({ type: 'kiwi:test-llm', llm: value }) as Promise<TestReply | undefined>} />
    </>
  );
}
