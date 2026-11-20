import {
  classifySyncPath,
  makeMembershipElementPath,
  parseMembershipElementPath,
  type AppliedChange,
  type LocalChangeInput,
} from '@kiwi-search/sync';
import { DEFAULT_CONFIG, type FusionConfig } from '@kiwi-search/core';
import { preferenceKeys, storageKey, type DomainPreferenceState } from '@kiwi-search/protocol';
import type { SettingsPatch } from './configUpdates';

const MEMBERSHIP_PATHS = new Set(['config.judge.blockedDomains', 'config.judge.boostedDomains']);
const SYNCED_UI_KEYS = new Set<string>([...preferenceKeys.map(storageKey), 'academicLanguage']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Convert settings patches produced by the options page or web bridge into sync engine changes. */
export function settingsPatchesToSyncChanges(patches: readonly SettingsPatch[]): LocalChangeInput[] {
  const out: LocalChangeInput[] = [];
  for (const patch of patches) {
    if (!patch.path.length) continue;
    const basePath = `config.${patch.path.join('.')}`;
    if ('add' in patch) {
      for (const item of patch.add) {
        out.push({ path: makeMembershipElementPath(basePath, item), value: true });
      }
      for (const item of patch.subtract) {
        out.push({ path: makeMembershipElementPath(basePath, item), tombstone: true });
      }
      continue;
    }
    if ('remove' in patch) {
      out.push({ path: basePath, tombstone: true });
      continue;
    }
    if (MEMBERSHIP_PATHS.has(basePath) && Array.isArray(patch.value)) {
      for (const item of patch.value) {
        if (typeof item === 'string' && item) {
          out.push({ path: makeMembershipElementPath(basePath, item), value: true });
        }
      }
      continue;
    }
    flattenConfigValue(basePath, patch.value, out);
  }
  return out;
}

/** Convert a single domain preference transition into membership-element sync changes. */
export function domainTransitionToSyncChanges(
  domain: string,
  before: DomainPreferenceState,
  after: DomainPreferenceState,
): LocalChangeInput[] {
  const out: LocalChangeInput[] = [];
  if (before.blocked !== after.blocked) {
    const path = makeMembershipElementPath('config.judge.blockedDomains', domain);
    out.push(after.blocked ? { path, value: true } : { path, tombstone: true });
  }
  if (before.boosted !== after.boosted) {
    const path = makeMembershipElementPath('config.judge.boostedDomains', domain);
    out.push(after.boosted ? { path, value: true } : { path, tombstone: true });
  }
  return out;
}

/** Convert chrome.storage.local preference updates into sync changes. */
export function uiStorageChangesToSyncChanges(
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
): LocalChangeInput[] {
  const out: LocalChangeInput[] = [];
  for (const [key, change] of Object.entries(changes)) {
    if (!SYNCED_UI_KEYS.has(key)) continue;
    if (JSON.stringify(change.oldValue) === JSON.stringify(change.newValue)) continue;
    if (change.newValue === undefined) out.push({ path: key, tombstone: true });
    else out.push({ path: key, value: change.newValue });
  }
  return out;
}

/** Convert applied remote sync changes into serialized config patches and storage preference updates. */
export function appliedChangesToLocalUpdates(applied: readonly AppliedChange[]): {
  configPatches: SettingsPatch[];
  storageUpdates: Record<string, unknown>;
  storageRemovals: string[];
} {
  const configPatches: SettingsPatch[] = [];
  const membershipAdds = new Map<string, Set<string>>();
  const membershipSubs = new Map<string, Set<string>>();
  const storageUpdates: Record<string, unknown> = {};
  const storageRemovals: string[] = [];
  const latestByPath = new Map<string, AppliedChange>();

  for (const item of applied) {
    latestByPath.set(item.path, item);
  }

  for (const item of latestByPath.values()) {
    if (SYNCED_UI_KEYS.has(item.path)) {
      if (item.tombstone) storageRemovals.push(item.path);
      else storageUpdates[item.path] = item.value;
      continue;
    }

    const membership = parseMembershipElementPath(item.path);
    if (membership && membership.basePath.startsWith('config.')) {
      const target = item.tombstone ? membershipSubs : membershipAdds;
      let set = target.get(membership.basePath);
      if (!set) {
        set = new Set<string>();
        target.set(membership.basePath, set);
      }
      set.add(membership.element);
      continue;
    }

    if (item.path.startsWith('config.')) {
      const segs = item.path.slice('config.'.length).split('.').filter(Boolean);
      if (!segs.length) continue;
      if (item.tombstone) configPatches.push({ path: segs, remove: true });
      else configPatches.push({ path: segs, value: item.value });
    }
  }

  const allMembershipBases = new Set([...membershipAdds.keys(), ...membershipSubs.keys()]);
  for (const basePath of allMembershipBases) {
    const segs = basePath.slice('config.'.length).split('.').filter(Boolean);
    const add = [...(membershipAdds.get(basePath) ?? [])];
    const subtract = [...(membershipSubs.get(basePath) ?? [])];
    configPatches.push({ path: segs, add, subtract });
  }

  return { configPatches, storageUpdates, storageRemovals };
}

function flattenConfigValue(prefix: string, value: unknown, out: LocalChangeInput[]): void {
  if (MEMBERSHIP_PATHS.has(prefix) && Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item) {
        out.push({ path: makeMembershipElementPath(prefix, item), value: true });
      }
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'version' && prefix === 'config') continue;
      flattenConfigValue(`${prefix}.${key}`, nested, out);
    }
    return;
  }
  if (value !== undefined) {
    out.push({ path: prefix, value });
  }
}

/**
 * Extract local settings that differ from DEFAULT_CONFIG (plus any non-empty domain entries and UI prefs).
 * Defaults never generate sync records, so a fresh device never overwrites a group's configuration.
 */
export function extractNonDefaultLocalChanges(
  config: FusionConfig,
  storageValues: Record<string, unknown>,
): LocalChangeInput[] {
  const out: LocalChangeInput[] = [];
  diffAgainstDefault('config', DEFAULT_CONFIG as unknown, config as unknown, out);
  for (const key of SYNCED_UI_KEYS) {
    if (storageValues[key] !== undefined) {
      out.push({ path: key, value: storageValues[key] });
    }
  }
  return out.filter((change) => classifySyncPath(change.path) !== null);
}

function diffAgainstDefault(
  prefix: string,
  defVal: unknown,
  curVal: unknown,
  out: LocalChangeInput[],
): void {
  if (JSON.stringify(defVal) === JSON.stringify(curVal)) return;
  if (MEMBERSHIP_PATHS.has(prefix) && Array.isArray(curVal)) {
    for (const item of curVal) {
      if (typeof item === 'string' && item) {
        out.push({ path: makeMembershipElementPath(prefix, item), value: true });
      }
    }
    return;
  }
  if (isPlainObject(curVal)) {
    const defObj = isPlainObject(defVal) ? defVal : {};
    for (const key of Object.keys(curVal)) {
      if (key === 'version' && prefix === 'config') continue;
      diffAgainstDefault(`${prefix}.${key}`, defObj[key], curVal[key], out);
    }
    return;
  }
  if (curVal !== undefined) {
    out.push({ path: prefix, value: curVal });
  }
}
