import { wikipediaFoldEnabled, type FusionConfig, type SourceId } from '@kiwi-search/core';
import { useMemo } from 'react';
import { browserLanguage } from '@/lib/language';
import { t } from '@/lib/i18n';
import { tr } from '@/lib/i18n/rich';
import { SOURCE_INFO } from '@/lib/sourceCatalog';
import { sourceLabel } from '@/lib/sourceMeta';
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
  const browserTag = useMemo(() => browserLanguage(), []);
  return (
    <section className="section" id="advanced" aria-labelledby="advanced-title">
      <details className="advanced" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
        <summary>
          <h2 id="advanced-title">{t('options.advanced.title')}</h2>
          <span>{t('options.advanced.summary')}</span>
        </summary>

        <div className="adv-block">
          <h3>{t('options.advanced.countsTitle')}</h3>
          <div className="field-grid">
            <NumberField label={t('options.advanced.countWeb')} value={config.perSourceCount} min={1} max={50} onChange={(perSourceCount) => onChange((c) => ({ ...c, perSourceCount }))} />
            <NumberField label={t('options.advanced.countImages')} value={config.imageCount} min={1} max={200} onChange={(imageCount) => onChange((c) => ({ ...c, imageCount }))} />
            <NumberField label={t('options.advanced.countVideo')} value={config.videoCount} min={1} max={50} onChange={(videoCount) => onChange((c) => ({ ...c, videoCount }))} />
            <NumberField label={t('options.advanced.countNotes')} value={config.noteCount} min={1} max={50} onChange={(noteCount) => onChange((c) => ({ ...c, noteCount }))} />
            <NumberField label={t('options.advanced.sourceTimeout')} value={config.sourceTimeoutMs} min={2000} step={1000} onChange={(sourceTimeoutMs) => onChange((c) => ({ ...c, sourceTimeoutMs }))} />
          </div>
        </div>

        <div className="adv-block">
          <h3>{t('options.advanced.pacingTitle')}</h3>
          <div className="field-grid">
            <NumberField label={t('options.advanced.minInterval')} hint={t('options.advanced.minIntervalHint')} value={config.renderer.minIntervalMs} min={0} step={500} onChange={(minIntervalMs) => setRenderer({ minIntervalMs })} />
            <NumberField label={t('options.advanced.workerIdle')} value={config.renderer.workerIdleMinutes} min={1} onChange={(workerIdleMinutes) => setRenderer({ workerIdleMinutes })} />
          </div>
          <SwitchRow checked={config.renderer.focusOnCaptcha} onChange={(focusOnCaptcha) => setRenderer({ focusOnCaptcha })} title={t('options.advanced.focusTitle')} hint={t('options.advanced.focusHint')} />
        </div>

        <div className="adv-block">
          <h3>{t('options.advanced.weightsTitle')}</h3>
          <p className="note">{t('options.advanced.weightsNote')}</p>
          <div className="field-grid weights">
            {enabled.map((id) => (
              <NumberField key={id} label={sourceLabel(id)} value={config.sources[id]?.weight ?? 1} min={0.1} max={5} step={0.1} onChange={(weight) => onWeight(id, weight)} />
            ))}
          </div>
        </div>

        <div className="adv-block">
          <h3>{t('options.advanced.wikipediaTitle')}</h3>
          {/* The switch shows what a search does: until the user chooses, that is on for a Chinese browser and off for any other. */}
          <SwitchRow
            checked={wikipediaFoldEnabled(config.judge.foldWikipediaEditions, browserTag)}
            onChange={(foldWikipediaEditions) => setJudge({ foldWikipediaEditions })}
            title={t('options.advanced.wikipediaFoldTitle')}
            hint={t('options.advanced.wikipediaFoldHint')}
          />
        </div>

        <div className="adv-block">
          <h3>{t('options.advanced.decisionParamsTitle')}</h3>
          <div className="field-grid">
            <NumberField label={t('options.advanced.candidates')} value={config.judge.candidates} min={5} max={50} onChange={(candidates) => setJudge({ candidates })} />
            <NumberField label={t('options.advanced.hideAbove')} hint={t('options.advanced.hideAboveHint')} value={config.judge.hideAbove} min={0.5} max={0.95} step={0.05} onChange={(hideAbove) => setJudge({ hideAbove })} />
            <NumberField label={t('options.advanced.judgeTimeout')} hint={t('options.advanced.judgeTimeoutHint')} value={config.judge.timeoutMs} min={1000} step={500} onChange={(timeoutMs) => setJudge({ timeoutMs })} />
            <NumberField label={t('options.advanced.intentThreshold')} hint={t('options.advanced.intentThresholdHint')} value={config.intent.threshold} min={0.3} max={0.95} step={0.05} onChange={(threshold) => setIntent({ threshold })} />
            <NumberField label={t('options.advanced.intentTimeout')} value={config.intent.timeoutMs} min={500} step={500} onChange={(timeoutMs) => setIntent({ timeoutMs })} />
            <NumberField label={t('options.advanced.switchThreshold')} hint={t('options.advanced.switchThresholdHint')} value={config.intent.switchThreshold} min={0.5} max={0.99} step={0.05} onChange={(switchThreshold) => setIntent({ switchThreshold })} />
          </div>
          <SwitchRow checked={config.intent.autoSwitch} onChange={(autoSwitch) => setIntent({ autoSwitch })} title={t('options.advanced.autoSwitchTitle')} hint={t('options.advanced.autoSwitchHint')} />
        </div>

        <div className="adv-block">
          <h3>{t('options.advanced.academicTitle')}</h3>
          <div className="field-grid">
            <NumberField label={t('options.advanced.landmarks')} value={config.academic.landmarks} min={1} max={10} onChange={(landmarks) => onChange((c) => ({ ...c, academic: { ...c.academic, landmarks } }))} />
            <NumberField label={t('options.advanced.academicTimeout')} hint={t('options.advanced.academicTimeoutHint')} value={config.academic.timeoutMs} min={3000} step={1000} onChange={(timeoutMs) => onChange((c) => ({ ...c, academic: { ...c.academic, timeoutMs } }))} />
          </div>
        </div>

        <div className="adv-block">
          <h3>{t('options.advanced.summaryTitle')}</h3>
          <div className="field-grid">
            <NumberField label={t('options.advanced.maxSources')} value={config.summary.maxSources} min={1} max={20} onChange={(maxSources) => setSummary({ maxSources })} />
            <Field label={t('options.advanced.fetcherLabel')}>
              <select value={config.summary.contentFetcher} onChange={(event) => setSummary({ contentFetcher: event.target.value as FusionConfig['summary']['contentFetcher'] })}>
                <option value="direct">{t('options.advanced.fetcherDirect')}</option>
                <option value="jina">Jina Reader</option>
                <option value="none">{t('options.advanced.fetcherNone')}</option>
              </select>
            </Field>
            <Field label={t('options.advanced.instructionsLabel')} wide>
              <textarea rows={3} value={config.summary.instructions ?? ''} placeholder={t('options.advanced.instructionsPlaceholder')} onChange={(event) => setSummary({ instructions: event.target.value })} />
            </Field>
          </div>
        </div>

        <div className="adv-block">
          <h3>{t('options.advanced.mcpTitle')}</h3>
          <p className="note">{tr('options.advanced.mcpNote', { tags: { code: (text) => <code>{text}</code> } })}</p>
          <SwitchRow checked={bridge.enabled} onChange={(enabled) => onBridge({ enabled })} title={t('options.advanced.mcpEnable')} />
          <div className="field-grid">
            <NumberField label={t('options.advanced.mcpPort')} value={bridge.port} min={1} max={65535} onChange={(port) => onBridge({ port })} />
            <Field label={t('options.advanced.mcpToken')}>
              <SecretInput label={t('options.advanced.mcpTokenAria')} value={bridge.token} placeholder={t('options.advanced.mcpTokenPlaceholder')} onChange={(token) => onBridge({ token: token.trim() })} />
            </Field>
          </div>
        </div>

        <div className="adv-block">
          <h3>{t('options.advanced.guideTitle')}</h3>
          <details className="inline-details">
            <summary>{t('options.advanced.guideSummary')}</summary>
            <StartSection config={config} health={health} />
          </details>
        </div>

        <div className="adv-block">
          <h3>{t('options.advanced.resetTitle')}</h3>
          <p className="note">{t('options.advanced.resetNote')}</p>
          <button type="button" className="btn" onClick={onReset}>
            {t('options.advanced.resetButton')}
          </button>
        </div>
      </details>
    </section>
  );
}
