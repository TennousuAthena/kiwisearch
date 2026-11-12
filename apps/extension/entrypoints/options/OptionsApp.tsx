import { DEFAULT_CONFIG, type FusionConfig, type SourceId } from '@kiwi-search/core';
import { useCallback, useEffect, useState } from 'react';
import { CheckIcon, CircleAlertIcon } from '@/lib/icons';
import { loadBlocklistMeta, watchBlocklistMeta } from '@/lib/blocklistService';
import type { BlocklistMetaMap } from '@/lib/blocklistState';
import { resetKeepingSecrets, tidyConfig } from '@/lib/configReset';
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
import { SOURCE_LABELS } from '@/lib/sourceMeta';
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
    ...(onboardingDone ? [] : [{ id: 'start', label: '开始使用' }]),
    { id: 'sources', label: '搜索范围' },
    { id: 'ai', label: 'AI 功能' },
    { id: 'filters', label: '屏蔽与偏好' },
    { id: 'advanced', label: '高级' },
  ];

  return (
    <div className="options-page">
      <div className="options-bar">
        <div className="options-bar-inner">
          <span className="options-brand">Kiwi Search</span>
          <div className="options-bar-side">
            <span className={`save-state ${saveState}`} role="status">
              {saveState === 'saving' && '正在保存…'}
              {saveState === 'saved' && (
                <>
                  <CheckIcon /> 已自动保存
                </>
              )}
              {saveState === 'error' && (
                <>
                  <CircleAlertIcon /> 保存失败：{saveError}
                </>
              )}
              {saveState === 'idle' && '改动会自动保存'}
            </span>
          </div>
        </div>
      </div>

      <div className="options-body">
        <nav className="options-nav" aria-label="设置分区">
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`} onClick={() => section.id === 'advanced' && setAdvancedOpen(true)}>
              {section.label}
            </a>
          ))}
        </nav>

        <main className="options-main">
          <header className="options-header">
            <h1>设置</h1>
            <p>选你想搜的地方，需要时再配 AI。其余的默认值已经够用。</p>
          </header>

          {!onboardingDone && (
            <section className="section" id="start" aria-labelledby="start-title">
              <h2 id="start-title">开始使用</h2>
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
          title={`确定要开启${SOURCE_LABELS[confirming]}吗？`}
          confirmLabel="仍然开启"
          onConfirm={() => {
            updateSource(confirming, 'enabled', true);
            setConfirming(null);
          }}
          onCancel={() => setConfirming(null)}
        >
          {SOURCE_INFO[confirming].confirm}
        </ConfirmDialog>
      )}
      {resetting && (
        <ConfirmDialog
          title="恢复默认设置？"
          confirmLabel="恢复默认"
          onConfirm={() => {
            setConfig(resetKeepingSecrets(config));
            setResetting(false);
          }}
          onCancel={() => setResetting(false)}
        >
          所有开关、规则和参数都会改回默认值，包括你屏蔽和优先的网站、订阅的屏蔽列表和自定义规则。你填的 Key 和地址、MCP 令牌会保留。
        </ConfirmDialog>
      )}
    </div>
  );
}
