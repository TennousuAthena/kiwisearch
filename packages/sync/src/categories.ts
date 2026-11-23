export type SyncCategory = 'search' | 'filters' | 'ui' | 'keys';

export interface SyncCategorySettings {
  search: boolean;
  filters: boolean;
  ui: boolean;
  /** Default false; must be explicitly confirmed per device. */
  keys: boolean;
}

export const DEFAULT_SYNC_CATEGORIES: SyncCategorySettings = {
  search: true,
  filters: true,
  ui: true,
  keys: false,
};

export const MEMBERSHIP_PATHS = new Set<string>([
  'config.judge.blockedDomains',
  'config.judge.boostedDomains',
]);

export const KEY_AND_ENDPOINT_PATTERNS: readonly RegExp[] = [
  /^config\.summary\.apiKey$/,
  /^config\.summary\.baseUrl$/,
  /^config\.judge\.apiKey$/,
  /^config\.judge\.endpoint$/,
  /^config\.judge\.baseUrl$/,
  /^config\.judge\.llm\.apiKey$/,
  /^config\.judge\.llm\.baseUrl$/,
  /^config\.llm\.apiKey$/,
  /^config\.llm\.baseUrl$/,
  /^config\.sources\.[^.]+\.apiKey$/,
  /^config\.sources\.[^.]+\.baseUrl$/,
  /^config\..+\.(apiKey|baseUrl|endpoint)$/,
];

const FILTER_PATTERNS: readonly RegExp[] = [
  /^config\.judge\./,
];

const UI_PATTERNS: readonly RegExp[] = [
  /^ui:(theme|summaryMode|openNewTab|recentQueries)$/,
  /^academicLanguage$/,
];

/**
 * Classifies a dotted sync path into its sync category, or null if not a known syncable path.
 * Sensitive patterns take precedence over general categories, except for explicitly shared fields.
 */
export function classifySyncPath(path: string): SyncCategory | null {
  if (!path || hasUnsafeSegment(path)) return null;
  if (/^(?:config\.)?(?:bridge|mcp)(?:\.|$)/i.test(path)) return null;
  // Membership element paths like "config.judge.blockedDomains#example.com"
  const basePath = extractMembershipBasePath(path) ?? path;
  if (basePath === 'config.sources.searxng.baseUrl') return 'search';

  for (const pattern of KEY_AND_ENDPOINT_PATTERNS) {
    if (pattern.test(basePath)) return 'keys';
  }
  for (const pattern of FILTER_PATTERNS) {
    if (pattern.test(basePath)) return 'filters';
  }
  for (const pattern of UI_PATTERNS) {
    if (pattern.test(basePath)) return 'ui';
  }
  if (basePath.startsWith('config.')) return 'search';
  return null;
}

export function isCategoryEnabled(categories: SyncCategorySettings, category: SyncCategory | null): boolean {
  if (!category) return false;
  return Boolean(categories[category]);
}

export function isMembershipPath(path: string): boolean {
  return MEMBERSHIP_PATHS.has(path);
}

export function makeMembershipElementPath(basePath: string, element: string): string {
  return `${basePath}#${element}`;
}

export function parseMembershipElementPath(path: string): { basePath: string; element: string } | null {
  const hashIdx = path.indexOf('#');
  if (hashIdx === -1) return null;
  const basePath = path.slice(0, hashIdx);
  if (!MEMBERSHIP_PATHS.has(basePath)) return null;
  const element = path.slice(hashIdx + 1);
  if (!element) return null;
  return { basePath, element };
}

export function extractMembershipBasePath(path: string): string | null {
  return parseMembershipElementPath(path)?.basePath ?? null;
}

export function hasUnsafeSegment(path: string): boolean {
  const base = path.split('#')[0]!;
  return base.split('.').some((seg) => !seg || seg === '__proto__' || seg === 'prototype' || seg === 'constructor');
}

export interface MigratedRecordEntry {
  path: string;
  value: unknown;
  tombstone?: boolean;
}

/**
 * Migrates a synced record entry from an older CONFIG_VERSION to the target CONFIG_VERSION.
 * Returns null if the record is deprecated/dropped, or the migrated entry.
 * Unknown paths from newer versions are preserved untouched for forwarding.
 */
export function migrateRecordEntry(
  entry: MigratedRecordEntry,
  fromConfigVersion: number,
  targetConfigVersion: number,
): MigratedRecordEntry {
  if (fromConfigVersion >= targetConfigVersion) return entry;
  // Config v1..v4 -> v5 renames (mirroring packages/core/src/config.ts MIGRATIONS):
  // If a legacy path appears from an older client, map it cleanly; otherwise pass through.
  let { path, value, tombstone } = entry;
  if (fromConfigVersion < 5 && path === 'config.blockedDomains') {
    path = 'config.judge.blockedDomains';
  } else if (fromConfigVersion < 5 && path === 'config.boostedDomains') {
    path = 'config.judge.boostedDomains';
  }
  return { path, value, tombstone };
}

/**
 * Validates and clamps a synced value before applying it to local config/preferences.
 * Returns { ok: true, value } or { ok: false, reason }.
 */
export function validateAndClampSyncValue(
  path: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (hasUnsafeSegment(path)) return { ok: false, reason: 'Unsafe path segment' };

  const membership = parseMembershipElementPath(path);
  if (membership) {
    if (value !== true && value !== null) {
      return { ok: false, reason: 'Membership element value must be true or tombstone' };
    }
    return { ok: true, value };
  }

  if (path === 'config.timeoutMs') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'Invalid timeoutMs' };
    return { ok: true, value: Math.max(1000, Math.min(60_000, Math.round(value))) };
  }
  if (path === 'config.maxConcurrency') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'Invalid maxConcurrency' };
    return { ok: true, value: Math.max(1, Math.min(20, Math.round(value))) };
  }
  if (path === 'config.judge.threshold') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'Invalid judge.threshold' };
    return { ok: true, value: Math.max(0, Math.min(1, value)) };
  }
  if (path === 'preferences.resultsPerPage') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: 'Invalid resultsPerPage' };
    return { ok: true, value: Math.max(5, Math.min(100, Math.round(value))) };
  }

  // Reject functions, symbols, huge values (> 16 KiB serialized)
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > 16_384) {
      return { ok: false, reason: 'Value exceeds 16 KiB limit' };
    }
  } catch {
    return { ok: false, reason: 'Non-serializable value' };
  }

  return { ok: true, value };
}
