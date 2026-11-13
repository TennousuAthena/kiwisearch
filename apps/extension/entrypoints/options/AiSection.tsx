import { decisionModelUsable, llmUsable, systemOneUsable, type FusionConfig, type JudgeProvider } from '@kiwi-search/core';
import { t } from '@/lib/i18n';
import { DecisionFields } from './DecisionFields';
import { Field, RuleList, SecretInput, Segmented, SwitchRow } from './controls';
import { LanguageFields } from './LanguageFields';
import { LlmFields } from './LlmFields';

interface Props {
  config: FusionConfig;
  onChange: (update: (config: FusionConfig) => FusionConfig) => void;
}

/** In the order shown; each one is named by the message `options.ai.provider.<value>`. */
const PROVIDERS: JudgeProvider[] = ['systemone', 'llm', 'none'];

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
  // The chat model is the main decision model (`llm`), or the stand-in behind a dedicated one.
  const chatModelInUse = provider === 'llm' || (provider === 'systemone' && judge.fallbackToLlm);

  const setJudge = (patch: Partial<FusionConfig['judge']>) => onChange((c) => ({ ...c, judge: { ...c.judge, ...patch } }));
  const setJudgeLlm = (patch: Partial<FusionConfig['judge']['llm']>) => onChange((c) => ({ ...c, judge: { ...c.judge, llm: { ...c.judge.llm, ...patch } } }));
  const setLlm = (patch: Partial<FusionConfig['llm']>) => onChange((c) => ({ ...c, llm: { ...c.llm, ...patch } }));
  const setSummary = (patch: Partial<FusionConfig['summary']>) => onChange((c) => ({ ...c, summary: { ...c.summary, ...patch } }));
  const setRerank = (patch: Partial<FusionConfig['rerank']>) => onChange((c) => ({ ...c, rerank: { ...c.rerank, ...patch } }));

  return (
    <section className="section" id="ai" aria-labelledby="ai-title">
      <h2 id="ai-title">{t('options.ai.title')}</h2>
      <p className="lead">{t('options.ai.lead')}</p>

      <div className="card">
        <strong className="card-title">{t('options.ai.modelTitle')}</strong>
        <p className="card-lead">{t('options.ai.modelLead')}</p>
        <div className="card-body">
          <LlmFields value={config.llm} onChange={setLlm} label={t('options.ai.modelLabel')} />
        </div>
      </div>

      <div className="card">
        <strong className="card-title">{t('options.ai.summaryTitle')}</strong>
        <p className="card-lead">{t('options.ai.summaryHint')} <a href="#preferences">{t('options.ai.summaryPreferences')}</a></p>
        <div className="card-body">
          <Field label={t('options.ai.summarySourceLabel')}>
            <select value={config.summary.provider} onChange={(event) => setSummary({ provider: event.target.value as FusionConfig['summary']['provider'] })}>
              <option value="api">{t('options.ai.summarySourceApi')}</option>
              <option value="chrome-builtin">{t('options.ai.summarySourceBuiltin')}</option>
            </select>
          </Field>
          <LanguageFields summary={config.summary} onChange={setSummary} />
        </div>
      </div>

      <div className="card">
        <SwitchRow
          checked={config.academic.smart}
          disabled={!modelReady}
          onChange={(smart) => onChange((c) => ({ ...c, academic: { ...c.academic, smart } }))}
          title={t('options.ai.smartTitle')}
          hint={modelReady ? t('options.ai.smartHint') : t('options.ai.smartNeedsModel')}
        />
      </div>

      <div className="card">
        <strong className="card-title">{t('options.ai.decisionTitle')}</strong>
        <p className="card-lead">{t('options.ai.decisionLead')}</p>
        <div className="card-body">
          <Segmented label={t('options.ai.providerLabel')} value={provider} options={PROVIDERS.map((value) => ({ value, label: t(`options.ai.provider.${value}`) }))} onChange={(next) => setJudge({ provider: next })} />

          {provider === 'systemone' && !dedicatedReady && (
            <p className="notice" role="status">
              {judge.fallbackToLlm && modelReady ? t('options.ai.noticeFallback') : t('options.ai.noticeDisabled')}
            </p>
          )}

          {provider === 'systemone' && <DecisionFields judge={judge} onChange={setJudge} />}

          {provider === 'systemone' && (
            <SwitchRow
              checked={judge.fallbackToLlm}
              onChange={(fallbackToLlm) => setJudge({ fallbackToLlm })}
              title={t('options.ai.fallbackTitle')}
              hint={t('options.ai.fallbackHint')}
            />
          )}

          {chatModelInUse && (
            <>
              {provider === 'systemone' && <p className="card-lead">{t('options.ai.standInLead')}</p>}
              <SwitchRow
                checked={judge.llmShared}
                onChange={(llmShared) => setJudge({ llmShared })}
                title={t('options.ai.sharedTitle')}
                hint={judge.llmShared ? t('options.ai.sharedHintShared') : t('options.ai.sharedHintSeparate')}
              />
              {!judge.llmShared && <LlmFields value={judge.llm} onChange={setJudgeLlm} label={t('options.ai.decisionLabel')} />}
              {judge.llmShared && !modelReady && <p className="note">{t('options.ai.sharedNeedsModel')}</p>}
            </>
          )}

          {provider !== 'none' && (
            <p className="note">
              {provider === 'systemone' && dedicatedReady
                ? t(judge.fallbackToLlm ? 'options.ai.privacyDedicatedFallback' : 'options.ai.privacyDedicated', { host: hostOf(judge.endpoint) })
                : t('options.ai.privacyModel')}
            </p>
          )}

          {provider !== 'none' && (
            <>
              <SwitchRow
                checked={config.intent.enabled}
                disabled={!decisionReady}
                onChange={(enabled) => onChange((c) => ({ ...c, intent: { ...c.intent, enabled } }))}
                title={t('options.ai.intentTitle')}
                hint={decisionReady ? t('options.ai.intentHint') : t('options.ai.intentNeedsDecision')}
              />
              <RuleList
                label={t('options.ai.rulesLabel')}
                values={judge.rules}
                onChange={(rules) => setJudge({ rules })}
                placeholder={t('options.ai.rulesPlaceholder')}
              />
            </>
          )}

          {!decisionReady && (
            <details className="inline-details">
              <summary>{t('options.ai.rerankSummary')}</summary>
              <p className="note">{t('options.ai.rerankNote')}</p>
              <div className="field-grid">
                <Field label={t('options.ai.rerankLabel')}>
                  <select value={config.rerank.provider} onChange={(event) => setRerank({ provider: event.target.value as FusionConfig['rerank']['provider'] })}>
                    <option value="none">{t('options.ai.rerankNone')}</option>
                    <option value="llm">{t('options.ai.rerankLlm')}</option>
                    <option value="jina">Jina</option>
                    <option value="cohere">Cohere</option>
                  </select>
                </Field>
                {(config.rerank.provider === 'jina' || config.rerank.provider === 'cohere') && (
                  <Field label={`${config.rerank.provider === 'jina' ? 'Jina' : 'Cohere'} API Key`}>
                    <SecretInput label={t('options.ai.rerankKeyAria')} value={config.rerank.apiKey ?? ''} onChange={(apiKey) => setRerank({ apiKey })} />
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
