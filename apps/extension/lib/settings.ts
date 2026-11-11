import { DEFAULT_CONFIG, mergeConfig, migrateConfig, type FusionConfig } from '@kiwi-search/core';
import { browser } from 'wxt/browser';

export interface BridgeSettings {
  enabled: boolean;
  port: number;
  token: string;
}

export const DEFAULT_BRIDGE: BridgeSettings = { enabled: true, port: 17345, token: '' };

export async function loadConfig(): Promise<FusionConfig> {
  const { config } = await browser.storage.local.get('config');
  return mergeConfig(DEFAULT_CONFIG, migrateConfig(config));
}

export async function saveConfig(config: FusionConfig): Promise<void> {
  await browser.storage.local.set({ config });
}

export async function loadBridge(): Promise<BridgeSettings> {
  const { bridge } = await browser.storage.local.get('bridge');
  return { ...DEFAULT_BRIDGE, ...(bridge as Partial<BridgeSettings> | undefined) };
}

export async function saveBridge(bridge: BridgeSettings): Promise<void> {
  await browser.storage.local.set({ bridge });
}

/** Whether the "开始使用" guide on the settings page has been finished or dismissed. Not part of the search config. */
export async function loadOnboardingDone(): Promise<boolean> {
  const { onboarding } = await browser.storage.local.get('onboarding');
  return !!(onboarding as { done?: boolean } | undefined)?.done;
}

export async function saveOnboardingDone(done: boolean): Promise<void> {
  await browser.storage.local.set({ onboarding: { done } });
}
