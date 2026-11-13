import { DEFAULT_CONFIG, type FusionConfig, type SourceId } from '@kiwi-search/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, CircleAlertIcon } from '@/lib/icons';
import { loadBlocklistMeta, watchBlocklistMeta } from '@/lib/blocklistService';
import type { BlocklistMetaMap } from '@/lib/blocklistState';
import { resetKeepingSecrets, tidyConfig } from '@/lib/configReset';
import { t } from '@/lib/i18n';
import { KiwiLogo } from '@/lib/KiwiLogo';
import { UiPreferencesPanel } from '@/lib/UiPreferencesPanel';
import {
  DEFAULT_BRIDGE,
  loadBridge,
  loadConfig,
  loadOnboardingDone,
  saveSettings,
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
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const baseline = useRef<{ config: FusionConfig; bridge: BridgeSettings } | null>(null);
  const saveVersion = useRef(0);
  const savedVersion = useRef(0);
  const [onboardingDone, setOnboardingDone] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(() => location.hash === '#advanced');
  const [currentSection, setCurrentSection] = useState('sources');
  const [confirming, setConfirming] = useState<SourceId | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadError(false);
    void Promise.all([loadConfig(), loadBridge(), loadSourceStatus().catch(() => ({})), loadOnboardingDone()]).then(([nextConfig, nextBridge, nextHealth, done]) => {
      if (!active) return;
      const config = tidyConfig(nextConfig);
      baseline.current = { config, bridge: nextBridge };
      setConfig(config);
      setBridge(nextBridge);
      setHealth(nextHealth);
      setOnboardingDone(done);
      setLoaded(true);
    }).catch(() => { if (active) setLoadError(true); });
    void loadBlocklistMeta().then((value) => { if (active) setBlocklistMeta(value); }).catch(() => {});
    return () => { active = false; };
  }, [loadAttempt]);

  useEffect(() => {
    const stopHealth = watchSourceStatus(setHealth);
    const stopBlocklists = watchBlocklistMeta(setBlocklistMeta);
    return () => {
      stopHealth();
      stopBlocklists();
    };
  }, []);

  // One value for the autosave to watch, so config and bridge are written together.
  const both = { config, bridge };
  const { state: saveState, error: saveError, retry: retrySave } = useAutosave(both, loaded, async (value, superseded) => {
    if (!baseline.current) return;
    const version = ++saveVersion.current;
    await saveSettings(value, baseline.current, superseded);
    if (version > savedVersion.current) { baseline.current = value; savedVersion.current = version; }
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
    { id: 'preferences', label: t('options.ux.preferences') },
    { id: 'sources', label: t('options.nav.sources') },
    { id: 'ai', label: t('options.nav.ai') },
    { id: 'filters', label: t('options.nav.filters') },
    { id: 'advanced', label: t('options.nav.advanced') },
  ];
  const confirmKey = confirming ? SOURCE_INFO[confirming].confirm : undefined;

  useEffect(() => {
    if (!loaded) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const ids = [...(onboardingDone ? [] : ['start']), 'preferences', 'sources', 'ai', 'filters', 'advanced'];
      const positions = ids.map((id) => ({ id, top: document.getElementById(id)?.getBoundingClientRect().top ?? Infinity }));
      const atBottom = window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      setCurrentSection(atBottom ? ids.at(-1)! : positions.filter((item) => item.top <= 150).at(-1)?.id ?? ids[0]);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const onHash = () => {
      if (location.hash === '#advanced') setAdvancedOpen(true);
      const id = location.hash.slice(1);
      if (id) requestAnimationFrame(() => { document.getElementById(id)?.scrollIntoView(); update(); });
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', onHash);
    onHash();
    update();
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); window.removeEventListener('hashchange', onHash); };
  }, [loaded, onboardingDone]);

  if (!loaded) return (
    <div className="options-page"><main className="options-load" aria-busy={!loadError}>
      <KiwiLogo fullName />
      {loadError ? <div role="alert"><h1>{t('options.ux.loadFailed')}</h1><p>{t('options.ux.loadFailedHint')}</p><button type="button" className="btn btn-primary" onClick={() => setLoadAttempt((value) => value + 1)}>{t('options.ux.retry')}</button></div> : <p role="status">{t('options.ux.loading')}</p>}
    </main></div>
  );

  return (
    <div className="options-page">
      <div className="options-bar">
        <div className="options-bar-inner">
          <span className="options-brand"><KiwiLogo fullName /></span>
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
            {saveState === 'error' && <button type="button" className="btn small" onClick={retrySave}>{t('options.ux.retrySave')}</button>}
          </div>
        </div>
      </div>

      <div className="options-body">
        <nav className="options-nav" aria-label={t('options.app.navLabel')}>
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`} aria-current={currentSection === section.id ? 'location' : undefined} onClick={() => { setCurrentSection(section.id); if (section.id === 'advanced') setAdvancedOpen(true); }}>
              {section.label}
            </a>
          ))}
        </nav>

        <main className="options-main">
          <header className="options-header">
            <h1>{t('options.app.title')}</h1>
            <p>{t('options.app.intro')}</p>
          </header>
          {saveState === 'error' && <p className="notice save-draft-notice" role="alert">{t('options.ux.unsavedHint')}</p>}

          {!onboardingDone && (
            <section className="section" id="start" aria-labelledby="start-title">
              <h2 id="start-title">{t('options.start.title')}</h2>
              <StartSection config={config} health={health} onDone={finishOnboarding} />
            </section>
          )}

          <section className="section" id="preferences" aria-labelledby="preferences-title">
            <h2 id="preferences-title">{t('options.ux.preferences')}</h2>
            <UiPreferencesPanel />
          </section>

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
