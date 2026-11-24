import {
  classifySyncPath,
  CUSTOM_LLM_ENDPOINT_PATH,
  LEGACY_LLM_PATH,
  LLM_SELECTION_PATH,
  makeMembershipElementPath,
  parseMembershipElementPath,
  SEARXNG_KEY_PATH,
  type AppliedChange,
  type LocalChangeInput,
} from '@kiwi-search/sync';
import { DEFAULT_CONFIG, LLM_PRESETS, httpOrigin, llmApiFormat, profileLlmSettings, type FusionConfig, type LlmProfile, type LlmSelection } from '@kiwi-search/core';
import { preferenceKeys, storageKey, type DomainPreferenceState } from '@kiwi-search/protocol';
import type { SettingsPatch } from './configUpdates';

const MEMBERSHIP_PATHS = new Set(['config.judge.blockedDomains', 'config.judge.boostedDomains']);
const SYNCED_UI_KEYS = new Set<string>([...preferenceKeys.map(storageKey), 'academicLanguage']);
const CUSTOM_PROFILE_PATCH = /^(config\.(?:judge\.)?llm\.profiles\.custom)(?:\.(?:baseUrl|apiKey|apiKeyOrigin|apiKeyCleared|apiFormat))?$/;

function isMappedPath(path: string): boolean {
  return !LEGACY_LLM_PATH.test(path) && !CUSTOM_PROFILE_PATCH.test(path) && classifySyncPath(path) !== null;
}

function customProfile(path: string, config?: FusionConfig) {
  return (path.startsWith('config.judge.') ? config?.judge.llm : config?.llm)?.profiles?.custom;
}

function customEndpointChange(path: string, config?: FusionConfig): LocalChangeInput {
  const profile = customProfile(path, config);
  if (!profile) return { path, tombstone: true };
  const { baseUrl = '', apiKey, apiKeyCleared } = profile;
  const apiKeyOrigin = apiKey && httpOrigin(profile.apiKeyOrigin);
  return { path, value: {
    baseUrl, apiFormat: llmApiFormat(profile.apiFormat),
    ...(apiKey ? { apiKey, ...(apiKeyOrigin ? { apiKeyOrigin } : {}) } : apiKeyCleared ? { apiKeyCleared } : {}),
  } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Convert settings patches produced by the options page or web bridge into sync engine changes. */
export function settingsPatchesToSyncChanges(patches: readonly SettingsPatch[], config?: FusionConfig): LocalChangeInput[] {
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
  for (const patch of patches) {
    const match = CUSTOM_PROFILE_PATCH.exec(`config.${patch.path.join('.')}`);
    if (match) out.push(customEndpointChange(`${match[1]}.endpoint`, config));
  }
  return [...new Map(out.filter((change) => isMappedPath(change.path)).map((change) => [change.path, withBoundOrigin(change, config)])).values()];
}

function withBoundOrigin(change: LocalChangeInput, config?: FusionConfig): LocalChangeInput {
  const source = config?.sources.searxng;
  if (change.path !== SEARXNG_KEY_PATH || !change.value || change.value !== source?.apiKey) return change;
  const origin = httpOrigin(source.apiKeyOrigin);
  return origin ? { ...change, pairedUrl: origin } : change;
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

/** Convert changed local preference saves into sync changes. */
export function uiPreferenceWritesToSyncChanges(
  values: Record<string, unknown>,
  current: Record<string, unknown>,
): LocalChangeInput[] {
  const out: LocalChangeInput[] = [];
  for (const [path, value] of Object.entries(values)) {
    if (!SYNCED_UI_KEYS.has(path) || value === undefined || value === current[path]) continue;
    out.push({ path, value });
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
      if (!isMappedPath(item.path)) continue;
      const segs = item.path.slice('config.'.length).split('.').filter(Boolean);
      if (!segs.length) continue;
      if (LLM_SELECTION_PATH.test(item.path)) {
        const selection = item.tombstone ? { provider: 'deepseek', model: LLM_PRESETS.deepseek.model } : item.value as LlmSelection;
        configPatches.push({ path: segs, value: selection });
        configPatches.push({ path: [...segs.slice(0, -1), 'profiles', selection.provider, 'model'], value: selection.model });
        continue;
      }
      if (CUSTOM_LLM_ENDPOINT_PATH.test(item.path)) {
        const endpoint = item.tombstone ? undefined : item.value as Partial<LlmProfile>;
        const fields: (keyof LlmProfile)[] = ['baseUrl', 'apiFormat'];
        if (endpoint?.apiKey || endpoint?.apiKeyCleared) fields.push('apiKey', 'apiKeyOrigin', 'apiKeyCleared');
        for (const field of fields) {
          const path = [...segs.slice(0, -1), field];
          const value = field === 'apiKeyOrigin' ? httpOrigin(endpoint?.apiKeyOrigin) : endpoint?.[field];
          configPatches.push(value === undefined ? { path, remove: true } : { path, value });
        }
        continue;
      }
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
  if (isPlainObject(value) && !LLM_SELECTION_PATH.test(prefix)) {
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
  const defaults = { ...DEFAULT_CONFIG, llm: profileLlmSettings(DEFAULT_CONFIG.llm), judge: { ...DEFAULT_CONFIG.judge, llm: profileLlmSettings(DEFAULT_CONFIG.judge.llm) } };
  diffAgainstDefault('config', defaults, config, out);
  for (const path of ['config.llm.profiles.custom.endpoint', 'config.judge.llm.profiles.custom.endpoint']) {
    const profile = customProfile(path, config);
    if (profile?.baseUrl || profile?.apiKey || profile?.apiKeyCleared || llmApiFormat(profile?.apiFormat) !== 'chat-completions') {
      out.push(customEndpointChange(path, config));
    }
  }
  for (const key of SYNCED_UI_KEYS) {
    if (storageValues[key] !== undefined) {
      out.push({ path: key, value: storageValues[key] });
    }
  }
  return out.filter((change) => isMappedPath(change.path)).map((change) => withBoundOrigin(change, config));
}

export function readLocalSyncChanges(
  paths: readonly string[],
  config: FusionConfig,
  storageValues: Record<string, unknown>,
): LocalChangeInput[] {
  const configValue = (path: string): unknown =>
    path.slice('config.'.length).split('.').reduce<unknown>(
      (value, key) => isPlainObject(value) ? value[key] : undefined, config,
    );
  return paths.filter(isMappedPath).map((path) => {
    if (CUSTOM_LLM_ENDPOINT_PATH.test(path)) return customEndpointChange(path, config);
    const membership = parseMembershipElementPath(path);
    if (membership) {
      const members = configValue(membership.basePath);
      return Array.isArray(members) && members.includes(membership.element)
        ? { path, value: true }
        : { path, tombstone: true };
    }
    const value = path.startsWith('config.') ? configValue(path) : storageValues[path];
    return value === undefined ? { path, tombstone: true } : withBoundOrigin({ path, value }, config);
  });
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
  if (isPlainObject(curVal) && !LLM_SELECTION_PATH.test(prefix)) {
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
