import { DEFAULT_SYSTEMONE_ENDPOINT, type FusionConfig } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { raw, t } from '@kiwi-search/app/i18n';
import { tr } from '@kiwi-search/app/i18n/rich';
import { Field, SecretInput } from './controls';
import { TestRow, type TestReply } from './TestRow';

type Judge = FusionConfig['judge'];

/** Where the dedicated decision model lives: TypeSafe's Jev as a preset, or any service that speaks the same protocol. */
export function DecisionFields({ judge, onChange }: { judge: Judge; onChange: (patch: Partial<Judge>) => void }) {
  const isTypeSafe = judge.endpoint === DEFAULT_SYSTEMONE_ENDPOINT;
  return (
    <>
      <div className="presets" role="group" aria-label={t('options.decision.serviceLabel')}>
        <button type="button" className="btn small" aria-pressed={isTypeSafe} onClick={() => onChange({ endpoint: DEFAULT_SYSTEMONE_ENDPOINT, model: 'jev-latest' })}>
          TypeSafe Jev
        </button>
        <button type="button" className="btn small" aria-pressed={!isTypeSafe} onClick={() => !judge.endpoint || isTypeSafe ? onChange({ endpoint: 'https://', model: '' }) : undefined}>
          {t('options.decision.customService')}
        </button>
      </div>
      <div className="field-grid">
        <Field label={t('options.decision.endpointLabel')} wide hint={isTypeSafe ? undefined : t('options.decision.endpointHint')}>
          <input value={judge.endpoint} placeholder="https://decide.example.com/v1/decide" onChange={(event) => onChange({ endpoint: event.target.value.trim() })} />
        </Field>
        <Field label={t('options.decision.modelLabel')}>
          <input value={judge.model} placeholder="jev-latest" onChange={(event) => onChange({ model: event.target.value })} />
        </Field>
        <Field label="API Key" hint={t('options.decision.keyHint')}>
          <SecretInput label={t('options.decision.keyAria')} value={judge.apiKey} placeholder={t('options.decision.keyPlaceholder')} onChange={(apiKey) => onChange({ apiKey })} />
        </Field>
      </div>
      <TestRow
        watch={`${judge.endpoint}|${judge.apiKey}|${judge.model}`}
        run={() => browser.runtime.sendMessage({ type: 'kiwi:test-decision', judge: { endpoint: judge.endpoint, apiKey: judge.apiKey, model: judge.model } }) as Promise<TestReply | undefined>}
      />
      <details className="inline-details">
        <summary>{t('options.decision.protocolSummary')}</summary>
        <p className="note">{t('options.decision.protocolIntro')}</p>
        <pre className="protocol">{raw('options.decision.protocol.raw')}</pre>
        <p className="note">{tr('options.decision.protocolDocs', { tags: { code: (text) => <code>{text}</code> } })}</p>
      </details>
    </>
  );
}
