import { editLlmEndpoint, httpOrigin, llmApiFormat, llmProfile, LLM_API_FORMATS, LLM_PROVIDERS, profileLlmSettings, resolveLlmSettings, type LlmProfile, type LlmSettings } from '@kiwi-search/core';
import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '@kiwi-search/app/i18n';
import { Field, SecretInput } from './controls';
import { TestRow, type TestReply } from './TestRow';
import type { LlmModelsReply } from '@/lib/llmModels';

/** The connection to one chat model: address, model, key, a few presets and a test button. */
export function LlmFields({ value, onChange, label }: { value: LlmSettings; onChange: (patch: Partial<LlmSettings>) => void; label: string }) {
  const settings = profileLlmSettings(value);
  const { provider, model } = settings.selection!;
  const profile = llmProfile(settings, provider);
  const connection = resolveLlmSettings(settings);
  const editProfile = (patch: Partial<LlmProfile>, nextModel?: string) => onChange({
    profiles: { ...settings.profiles, [provider]: { ...settings.profiles?.[provider], ...patch } },
    ...(nextModel !== undefined ? { selection: { provider, model: nextModel } } : {}),
  });
  const selectModel = (nextModel: string) => editProfile({ model: nextModel }, nextModel);
  const bindKey = (apiKey: string) => editProfile({ apiKey, ...(provider === 'custom' ? { apiKeyOrigin: apiKey ? httpOrigin(profile.baseUrl) : undefined } : {}) });
  const keyMismatch = provider === 'custom' && !!profile.apiKey && !connection.apiKey;
  const signature = JSON.stringify([provider, profile.baseUrl, profile.apiKey, profile.apiKeyOrigin, profile.apiFormat]);
  const current = useRef(signature);
  current.current = signature;
  const sequence = useRef(0);
  const [result, setResult] = useState<{ signature: string; reply?: LlmModelsReply }>();
  useEffect(() => {
    setResult(undefined);
    return () => { sequence.current++; };
  }, [signature]);
  const activeResult = result?.signature === signature ? result : undefined;
  const fetchModels = async () => {
    const serial = ++sequence.current;
    setResult({ signature });
    let reply: LlmModelsReply = { ok: false, reason: 'network' };
    try {
      reply = await browser.runtime.sendMessage({ type: 'kiwi:list-llm-models', provider, baseUrl: connection.baseUrl, apiKey: connection.apiKey, apiFormat: connection.apiFormat }) ?? reply;
    } catch { /* The background may be unavailable while the extension reloads. */ }
    if (serial === sequence.current && current.current === signature) setResult({ signature, reply });
  };
  return (
    <>
      <div className="presets" role="group" aria-label={t('options.llm.presetsLabel', { label })}>
        {LLM_PROVIDERS.map((id) => (
          <button key={id} type="button" className="btn small" aria-pressed={provider === id} onClick={() => id !== provider && onChange({ selection: { provider: id, model: llmProfile(settings, id).model } })}>
            {t(`preset.llm.${id}`)}
          </button>
        ))}
      </div>
      <div className="field-grid">
        <Field label={t('options.llm.baseUrlLabel')}>
          <input value={profile.baseUrl} onChange={(event) => onChange(editLlmEndpoint(settings, event.target.value))} />
        </Field>
        {provider === 'custom' && <Field label={t('options.llm.apiFormat')}>
          <select value={llmApiFormat(profile.apiFormat)} onChange={(event) => editProfile({ apiFormat: llmApiFormat(event.target.value) })}>
            {LLM_API_FORMATS.map((format) => <option key={format} value={format}>{t(`options.llm.format.${format}`)}</option>)}
          </select>
        </Field>}
        {provider === 'ollama' && <Field label={t('options.llm.ollamaOverride')}>
          <input value={settings.profiles?.ollama?.baseUrl ?? ''} placeholder={profile.baseUrl} onChange={(event) => editProfile({ baseUrl: event.target.value || undefined })} />
        </Field>}
        <Field label={t('options.llm.modelLabel')}>
          <input value={model} maxLength={512} onChange={(event) => selectModel(event.target.value)} />
        </Field>
        {provider !== 'ollama' && <Field label="API Key" wide>
          <SecretInput label={t('options.llm.keyAria', { label })} value={profile.apiKey} placeholder={t('options.llm.keyPlaceholder')} onChange={bindKey} />
        </Field>}
      </div>
      {keyMismatch && <p role="status" className="note">{t('options.llm.keyOriginMismatch')}{' '}
        <button type="button" className="btn small" disabled={!httpOrigin(profile.baseUrl)} onClick={() => bindKey(profile.apiKey)}>{t('options.llm.rebindKey')}</button>
      </p>}
      <button type="button" className="btn small" disabled={!!activeResult && !activeResult.reply} onClick={() => void fetchModels()}>
        {t(activeResult && !activeResult.reply ? 'options.llm.listLoading' : 'options.llm.list')}
      </button>
      {activeResult?.reply?.ok && (activeResult.reply.models.length
        ? <Field label={t('options.llm.listSelect')}>
          <select value={activeResult.reply.models.includes(model) ? model : ''} onChange={(event) => { if (event.target.value) selectModel(event.target.value); }}>
            <option value="">{t('options.llm.listPlaceholder')}</option>
            {activeResult.reply.models.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </Field>
        : <p role="status" className="note">{t('options.llm.listEmpty')}</p>)}
      {activeResult?.reply && !activeResult.reply.ok && <p role="status" className="note">
        {t(`options.llm.listError.${activeResult.reply.reason}`, { status: activeResult.reply.status ?? '' })}
      </p>}
      <TestRow watch={JSON.stringify(connection)} run={() => browser.runtime.sendMessage({ type: 'kiwi:test-llm', llm: connection }) as Promise<TestReply | undefined>} />
    </>
  );
}
