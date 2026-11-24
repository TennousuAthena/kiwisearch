import { DEFAULT_CONFIG, mergeConfig, migrateConfig, profileLlmSettings, type FusionConfig } from '@kiwi-search/core';
import { browser } from 'wxt/browser';
import { diffSettings, diffSettingsFromBaselines, sendSettingsUpdate } from './configUpdates';

export interface BridgeSettings {
  enabled: boolean;
  port: number;
  token: string;
}

export const DEFAULT_BRIDGE: BridgeSettings = { enabled: true, port: 17345, token: '' };

export async function loadConfig(): Promise<FusionConfig> {
  const { config } = await browser.storage.local.get('config');
  const merged = mergeConfig(DEFAULT_CONFIG, migrateConfig(config));
  return { ...merged, llm: profileLlmSettings(merged.llm), judge: { ...merged.judge, llm: profileLlmSettings(merged.judge.llm) } };
}

export async function saveConfig(config: FusionConfig, baseline: FusionConfig): Promise<void> {
  await sendSettingsUpdate({ type: 'kiwi:update-settings', config: diffSettings(baseline, config) });
}

export async function loadBridge(): Promise<BridgeSettings> {
  const { bridge } = await browser.storage.local.get('bridge');
  return { ...DEFAULT_BRIDGE, ...(bridge as Partial<BridgeSettings> | undefined) };
}

export async function saveBridge(bridge: BridgeSettings, baseline: BridgeSettings): Promise<void> {
  await sendSettingsUpdate({ type: 'kiwi:update-settings', bridge: diffSettings(baseline, bridge) });
}

export async function saveSettings(next: { config: FusionConfig; bridge: BridgeSettings }, baseline: { config: FusionConfig; bridge: BridgeSettings }, superseded: readonly { config: FusionConfig; bridge: BridgeSettings }[] = []): Promise<void> {
  const previous = [baseline, ...superseded];
  const config = diffSettingsFromBaselines(previous.map((value) => value.config), next.config);
  const keyPath = ['sources', 'searxng', 'apiKey'];
  const originPath = ['sources', 'searxng', 'apiKeyOrigin'];
  const keyPatch = config.some(({ path }) => path.join('.') === keyPath.join('.'));
  const originPatch = config.some(({ path }) => path.join('.') === originPath.join('.'));
  if (keyPatch || originPatch) {
    const source = next.config.sources.searxng;
    if (!keyPatch) config.push({ path: keyPath, value: source?.apiKey });
    if (!originPatch) config.push({ path: originPath, value: source?.apiKeyOrigin ?? null });
  }
  await sendSettingsUpdate({ type: 'kiwi:update-settings', config, bridge: diffSettingsFromBaselines(previous.map((value) => value.bridge), next.bridge) });
}

/**
 * The onboarding page's progress: finished (or skipped), or the step it was left at, so closing the tab does not start it over.
 * Not part of the search config. `done` was written by the guide that used to sit on the settings page; it means the same.
 */
export interface OnboardingState {
  done: boolean;
  step?: number;
}

export async function loadOnboarding(): Promise<OnboardingState> {
  const { onboarding } = await browser.storage.local.get('onboarding');
  const value = onboarding as Partial<OnboardingState> | undefined;
  return { done: !!value?.done, ...(typeof value?.step === 'number' ? { step: value.step } : {}) };
}

export async function saveOnboarding(state: OnboardingState): Promise<void> {
  await browser.storage.local.set({ onboarding: state });
}
