import { browser } from 'wxt/browser';
import { normalizeDomain, type DomainPreferenceAction, type DomainPreferenceState, type DomainPreferenceUndo } from '@kiwi-search/protocol';

export type SettingsPatch =
  | { path: string[]; value: unknown }
  | { path: string[]; remove: true }
  | { path: string[]; add: string[]; subtract: string[] };
export type { DomainPreferenceAction, DomainPreferenceState, DomainPreferenceUndo };
export type SettingsUpdate =
  | { type: 'kiwi:update-settings'; config?: SettingsPatch[]; bridge?: SettingsPatch[] }
  | { type: 'kiwi:update-settings'; domain: string; action: DomainPreferenceAction }
  | { type: 'kiwi:update-settings'; undo: DomainPreferenceUndo };
export type SettingsUpdateResponse = { ok: true; undo?: DomainPreferenceUndo; restored?: boolean } | { ok: false; error: string };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Compare the page's original draft, never the newest stored config. Unedited fields are omitted. */
export function diffSettings(baseline: unknown, next: unknown, path: string[] = []): SettingsPatch[] {
  if (JSON.stringify(baseline) === JSON.stringify(next)) return [];
  if (path[0] === 'judge' && ['blockedDomains', 'boostedDomains'].includes(path[1]) && Array.isArray(baseline) && Array.isArray(next)) {
    return [{ path, add: next.filter((value) => !baseline.includes(value)), subtract: baseline.filter((value) => !next.includes(value)) }];
  }
  if (isObject(next)) {
    const original = isObject(baseline) ? baseline : {};
    return [...new Set([...Object.keys(original), ...Object.keys(next)])].flatMap((key) => diffSettings(original[key], next[key], [...path, key]));
  }
  return next === undefined ? [{ path, remove: true }] : [{ path, value: next }];
}

/** Repair every locally touched field, whether an earlier in-flight snapshot committed or failed. */
export function diffSettingsFromBaselines(baselines: readonly unknown[], next: unknown): SettingsPatch[] {
  const patches = new Map<string, SettingsPatch>();
  for (const baseline of baselines) for (const patch of diffSettings(baseline, next)) {
    const key = JSON.stringify(patch.path);
    const previous = patches.get(key);
    if (previous && 'add' in previous && 'add' in patch) {
      patches.set(key, { path: patch.path, add: [...new Set([...previous.add, ...patch.add])], subtract: [...new Set([...previous.subtract, ...patch.subtract])] });
    } else patches.set(key, patch);
  }
  return [...patches.values()];
}

/** Apply a draft's changed fields to the latest stored value; domain lists merge by membership. */
export function applySettingsPatch<T>(current: T, patches: SettingsPatch[]): T {
  const next = structuredClone(current) as Record<string, unknown>;
  for (const patch of patches) {
    if (!patch.path.length || patch.path.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('Invalid settings path');
    let target = next;
    for (const key of patch.path.slice(0, -1)) {
      if (!isObject(target[key])) target[key] = {};
      target = target[key] as Record<string, unknown>;
    }
    const key = patch.path.at(-1)!;
    if ('remove' in patch) delete target[key];
    else if ('add' in patch) {
      const values = Array.isArray(target[key]) ? target[key] as string[] : [];
      target[key] = [...new Set([...values.filter((value) => !patch.subtract.includes(value)), ...patch.add])];
    } else target[key] = structuredClone(patch.value);
  }
  return next as T;
}

export async function sendSettingsUpdate(update: SettingsUpdate): Promise<Extract<SettingsUpdateResponse, { ok: true }>> {
  const response = await browser.runtime.sendMessage(update) as SettingsUpdateResponse | undefined;
  if (!response?.ok) throw new Error(response?.error ?? 'Settings update did not complete');
  return response;
}

/** Lightweight new-tab entry point: no runtime import of core or its source parsers. */
export async function updateDomainPreference(action: DomainPreferenceAction, input: string): Promise<DomainPreferenceUndo> {
  const domain = normalizeDomain(input);
  if (!domain) throw new Error('Invalid domain');
  const result = await sendSettingsUpdate({ type: 'kiwi:update-settings', action, domain });
  if (!result.undo) throw new Error('Missing domain update receipt');
  return result.undo;
}

/** False means a newer action changed this domain; unrelated domain edits are always retained. */
export async function undoDomainPreference(undo: DomainPreferenceUndo): Promise<boolean> {
  const result = await sendSettingsUpdate({ type: 'kiwi:update-settings', undo });
  return result.restored === true;
}
