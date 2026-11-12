import { DEFAULT_CONFIG, type FusionConfig, type SourceId } from '@kiwi-search/core';
import { useCallback, useEffect, useState } from 'react';
import { CheckIcon, CircleAlertIcon } from '@/lib/icons';
import { loadBlocklistMeta, watchBlocklistMeta } from '@/lib/blocklistService';
import type { BlocklistMetaMap } from '@/lib/blocklistState';
import { resetKeepingSecrets, tidyConfig } from '@/lib/configReset';
import { t } from '@/lib/i18n';
import {
  DEFAULT_BRIDGE,
  loadBridge,
  loadConfig,
  loadOnboardingDone,
  saveBridge,
  saveConfig,
  saveOnboardingDone,
  type BridgeSettings,
} from '@/lib/settings';
import { SOURCE_INFO } from '@/lib/sourceCatalog';
import type { SourceHealthMap } from '@/lib/sourceHealth';
import { sourceLabel } from '@/lib/sourceMeta';
import { loadSourceStatus, watchSourceStatus } from '@/lib/sourceStatus';
import { AdvancedSection } from './AdvancedSection';
import { AiSection } from './AiSection';
import { ConfirmDialog } from './controls';
import { FiltersSection } from './FiltersSection';
import { SourcesSection } from './SourcesSection';
import { StartSection } from './StartSection';
import { useAutosave } from './useAutosave';

export default function OptionsApp() {
  const [config, setConfig] = useState<FusionConfig>(() => structuredClone(DEFAULT_CONFIG));
  const [bridge, setBridge] = useState<BridgeSettings>(DEFAULT_BRIDGE);
  const [health, setHealth] = useState<SourceHealthMap>({});
  const [blocklistMeta, setBlocklistMeta] = useState<BlocklistMetaMap>({});
  const [loaded, setLoaded] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirming, setConfirming] = useState<SourceId | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    void Promise.all([loadConfig(), loadBridge(), loadSourceStatus(), loadOnboardingDone()]).then(([nextConfig, nextBridge, nextHealth, done]) => {
      setConfig(tidyConfig(nextConfig));
      setBridge(nextBridge);
      setHealth(nextHealth);
      setOnboardingDone(done);
      setLoaded(true);
    });
    void loadBlocklistMeta().then(setBlocklistMeta);
    const stopHealth = watchSourceStatus(setHealth);
    const stopBlocklists = watchBlocklistMeta(setBlocklistMeta);
    return () => {
      stopHealth();
      stopBlocklists();
    };
  }, []);

  // One value for the autosave to watch, so config and bridge are written together.
  const both = { config, bridge };
  const { state: saveState, error: saveError } = useAutosave(both, loaded, async (value) => {
    await Promise.all([saveConfig(value.config), saveBridge(value.bridge)]);
  });

  const change = useCallback((update: (current: FusionConfig) => FusionConfig) => setConfig(update), []);

  const updateSource = (id: SourceId, field: 'enabled' | 'apiKey' | 'baseUrl', value: boolean | string) =>
    change((current) => ({ ...current, sources: { ...current.sources, [id]: { ...(current.sources[id] ?? { enabled: false }), [field]: value } } }));

  const setEnabled = (enabled: Partial<Record<SourceId, boolean>>) =>
    change((current) => {
      const sources = { ...current.sources };
      for (const [id, on] of Object.entries(enabled) as [SourceId, boolean][]) sources[id] = { ...(sources[id] ?? { enabled: false }), enabled: on };
      return { ...current, sources };
    });

  const setWeight = (id: SourceId, weight: number) =>
    change((current) => ({ ...current, sources: { ...current.sources, [id]: { ...(current.sources[id] ?? { enabled: false }), weight } } }));

  const finishOnboarding = () => {
    setOnboardingDone(true);
    void saveOnboardingDone(true);
  };

  const sections = [
    ...(onboardingDone ? [] : [{ id: 'start', label: t('options.nav.start') }]),
    { id: 'sources', label: t('options.nav.sources') },
    { id: 'ai', label: t('options.nav.ai') },
    { id: 'filters', label: t('options.nav.filters') },
    { id: 'advanced', label: t('options.nav.advanced') },
  ];
  const confirmKey = confirming ? SOURCE_INFO[confirming].confirm : undefined;

  return (
    <div className="options-page">
      <div className="options-bar">
        <div className="options-bar-inner">
          <span className="options-brand">Kiwi Search</span>
          <div className="options-bar-side">
            <span className={`save-state ${saveState}`} role="status">
              {saveState === 'saving' && t('options.app.saving')}
              {saveState === 'saved' && (
                <>
                  <CheckIcon /> {t('options.app.saved')}
                </>
              )}
              {saveState === 'error' && (
                <>
                  <CircleAlertIcon /> {t('options.app.saveFailed', { error: saveError })}
                </>
              )}
              {saveState === 'idle' && t('options.app.idle')}
            </span>
          </div>
        </div>
      </div>

      <div className="options-body">
        <nav className="options-nav" aria-label={t('options.app.navLabel')}>
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`} onClick={() => section.id === 'advanced' && setAdvancedOpen(true)}>
              {section.label}
            </a>
          ))}
        </nav>

        <main className="options-main">
          <header className="options-header">
            <h1>{t('options.app.title')}</h1>
            <p>{t('options.app.intro')}</p>
          </header>

          {!onboardingDone && (
            <section className="section" id="start" aria-labelledby="start-title">
              <h2 id="start-title">{t('options.start.title')}</h2>
              <StartSection config={config} health={health} onDone={finishOnboarding} />
            </section>
          )}

          <SourcesSection config={config} health={health} onUpdate={updateSource} onSetEnabled={setEnabled} onConfirmEnable={setConfirming} />
          <AiSection config={config} onChange={change} />
          <FiltersSection config={config} blocklistMeta={blocklistMeta} onChange={change} />
          <AdvancedSection
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            config={config}
            bridge={bridge}
            health={health}
            onChange={change}
            onBridge={(patch) => setBridge((current) => ({ ...current, ...patch }))}
            onWeight={setWeight}
            onReset={() => setResetting(true)}
          />
        </main>
      </div>

      {confirming && (
        <ConfirmDialog
          title={t('options.app.enableTitle', { source: sourceLabel(confirming) })}
          confirmLabel={t('options.app.enableConfirm')}
          onConfirm={() => {
            updateSource(confirming, 'enabled', true);
            setConfirming(null);
          }}
          onCancel={() => setConfirming(null)}
        >
          {confirmKey && t(confirmKey)}
        </ConfirmDialog>
      )}
      {resetting && (
        <ConfirmDialog
          title={t('options.app.resetTitle')}
          confirmLabel={t('options.app.resetConfirm')}
          onConfirm={() => {
            setConfig(resetKeepingSecrets(config));
            setResetting(false);
          }}
          onCancel={() => setResetting(false)}
        >
          {t('options.app.resetBody')}
        </ConfirmDialog>
      )}
    </div>
  );
}
