import { DEFAULT_CONFIG, httpOrigin, type FusionConfig, type SourceId } from '@kiwi-search/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { CheckIcon, CircleAlertIcon, FilterIcon, GlobeIcon, SlidersIcon, SparkleIcon, SyncIcon, ToolsIcon } from '@kiwi-search/app/icons';
import { loadBlocklistMeta, watchBlocklistMeta } from '@/lib/blocklistService';
import type { BlocklistMetaMap } from '@/lib/blocklistState';
import { resetKeepingSecrets, tidyConfig } from '@/lib/configReset';
import { t } from '@kiwi-search/app/i18n';
import { KiwiLogo } from '@kiwi-search/app/KiwiLogo';
import { useUiSource } from '@/lib/useUiSource';
import { UiPreferencesPanel } from '@kiwi-search/app/UiPreferencesPanel';
import {
  DEFAULT_BRIDGE,
  loadBridge,
  loadConfig,
  saveSettings,
  type BridgeSettings,
} from '@/lib/settings';
import type { SourceHealthMap } from '@/lib/sourceHealth';
import { loadSourceStatus, watchSourceStatus } from '@/lib/sourceStatus';
import { StartSection } from './StartSection';
import { AdvancedSection } from './AdvancedSection';
import { AiSection } from './AiSection';
import { ConfirmDialog } from './controls';
import { EnableSourceDialog } from './EnableSourceDialog';
import { FiltersSection } from './FiltersSection';
import { SourcesSection } from './SourcesSection';
import { SyncSection } from './SyncSection';
import { useAutosave } from './useAutosave';

export default function OptionsApp() {
  const { homeUrl } = useUiSource();
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
  const lastSection = useRef('preferences');
  const [fragment, setFragment] = useState(() => location.hash.slice(1));
  const [confirming, setConfirming] = useState<SourceId | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let active = true;
    setLoadError(false);
    void Promise.all([loadConfig(), loadBridge(), loadSourceStatus().catch(() => ({}))]).then(([nextConfig, nextBridge, nextHealth]) => {
      if (!active) return;
      const config = tidyConfig(nextConfig);
      baseline.current = { config, bridge: nextBridge };
      setConfig(config);
      setBridge(nextBridge);
      setHealth(nextHealth);
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
  const saveStateRef = useRef<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const { state: saveState, error: saveError, retry: retrySave } = useAutosave(both, loaded, async (value, superseded) => {
    if (!baseline.current) return;
    if (!superseded?.length && JSON.stringify(value) === JSON.stringify(baseline.current)) return;
    const version = ++saveVersion.current;
    await saveSettings(value, baseline.current, superseded);
    if (version > savedVersion.current) { baseline.current = value; savedVersion.current = version; }
  });
  saveStateRef.current = saveState;

  useEffect(() => {
    const onChanged = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      if (areaName !== 'local' || !('config' in changes) || !baseline.current) return;
      if (saveStateRef.current === 'dirty' || saveStateRef.current === 'saving') return;
      void loadConfig().then((nextConfig) => {
        if (!baseline.current) return;
        const next = tidyConfig(nextConfig);
        if (JSON.stringify(next) === JSON.stringify(baseline.current.config)) return;
        baseline.current = { config: next, bridge: baseline.current.bridge };
        setConfig(next);
      }).catch(() => {});
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => { browser.storage.onChanged.removeListener(onChanged); };
  }, []);

  const change = useCallback((update: (current: FusionConfig) => FusionConfig) => setConfig(update), []);

  const updateSource = (id: SourceId, field: 'enabled' | 'apiKey' | 'baseUrl', value: boolean | string, keyUrl?: string | null) =>
    change((current) => {
      const source = { ...(current.sources[id] ?? { enabled: false }), [field]: value };
      if (id === 'searxng' && field === 'apiKey') source.apiKeyOrigin = value ? httpOrigin(keyUrl) : undefined;
      return { ...current, sources: { ...current.sources, [id]: source } };
    });

  const setEnabled = (enabled: Partial<Record<SourceId, boolean>>) =>
    change((current) => {
      const sources = { ...current.sources };
      for (const [id, on] of Object.entries(enabled) as [SourceId, boolean][]) sources[id] = { ...(sources[id] ?? { enabled: false }), enabled: on };
      return { ...current, sources };
    });

  const setWeight = (id: SourceId, weight: number) =>
    change((current) => ({ ...current, sources: { ...current.sources, [id]: { ...(current.sources[id] ?? { enabled: false }), weight } } }));

  const sections = [
    { id: 'preferences', icon: SlidersIcon, label: t('options.ux.preferences') },
    { id: 'sources', icon: GlobeIcon, label: t('options.nav.sources') },
    { id: 'ai', icon: SparkleIcon, label: t('options.nav.ai') },
    { id: 'filters', icon: FilterIcon, label: t('options.nav.filters') },
    { id: 'sync', icon: SyncIcon, label: t('options.nav.sync') },
    { id: 'advanced', icon: ToolsIcon, label: t('options.nav.advanced') },
  ];

  const currentSection = fragment === 'sync-connection' ? 'advanced'
    : sections.some(({ id }) => id === fragment) ? fragment : 'preferences';
  useEffect(() => {
    const navigate = () => { setFragment(location.hash.slice(1)); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);

  useEffect(() => {
    if (!loaded || !fragment) return;
    const destination = fragment === 'directory'
      ? document.querySelector<HTMLElement>(`.options-nav a[href="#${lastSection.current}"]`)
      : document.querySelector<HTMLElement>(`#${currentSection} h2`);
    if (fragment !== 'directory') lastSection.current = currentSection;
    if (destination) {
      if (destination.tagName === 'H2') destination.tabIndex = -1;
      destination.focus({ preventScroll: true });
    }
  }, [fragment, currentSection, loaded]);

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
          <a className="options-brand" href={homeUrl} aria-label={t('brand.home')}><KiwiLogo fullName /></a>
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

      <div className="options-body" data-directory={!fragment || fragment === 'directory'}>
        <nav className="options-nav" aria-label={t('options.app.navLabel')}>
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`} aria-current={currentSection === section.id ? 'location' : undefined}>
              <section.icon />
              {section.label}
            </a>
          ))}
        </nav>

        <main className="options-main">
          <a href="#directory" className="settings-back">{t('options.ux.directory')}</a>
          <header className="options-header">
            <h1>{t('options.app.title')}</h1>
          </header>
          {saveState === 'error' && <p className="notice save-draft-notice" role="alert">{t('options.ux.unsavedHint')}</p>}

          <section hidden={currentSection !== 'preferences'} className="section" id="preferences" aria-labelledby="preferences-title">
            <h2 id="preferences-title">{t('options.ux.preferences')}</h2>
            <UiPreferencesPanel />
            <StartSection config={config} health={health} />
          </section>

          <div hidden={currentSection !== 'sources'}><SourcesSection config={config} health={health} onUpdate={updateSource} onSetEnabled={setEnabled} onConfirmEnable={setConfirming} /></div>
          <div hidden={currentSection !== 'ai'}><AiSection config={config} onChange={change} /></div>
          <div hidden={currentSection !== 'filters'}><FiltersSection config={config} blocklistMeta={blocklistMeta} onChange={change} /></div>
          <div hidden={currentSection !== 'sync'}><SyncSection /></div>
          {currentSection === 'advanced' && <AdvancedSection
            config={config}
            bridge={bridge}
            onChange={change}
            onBridge={(patch) => setBridge((current) => ({ ...current, ...patch }))}
            onWeight={setWeight}
            onReset={() => setResetting(true)}
          />}
        </main>
      </div>

      {confirming && (
        <EnableSourceDialog
          id={confirming}
          onEnable={() => {
            updateSource(confirming, 'enabled', true);
            setConfirming(null);
          }}
          onCancel={() => setConfirming(null)}
        />
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
