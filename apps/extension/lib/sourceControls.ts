import type { FusionConfig, SourceId } from '@kiwi-search/core';
import type { SourceHealth } from './sourceHealth';
import { describeSource } from './sourceView';

export function sourceNeedsAttention(id: SourceId, config: FusionConfig, health?: SourceHealth): boolean {
  const badge = describeSource(id, config, health);
  return badge?.tone === 'warn' || badge?.tone === 'bad';
}

export type SourceEnabledPatch = Partial<Record<SourceId, boolean>>;
export interface SourcePresetUndo { before: SourceEnabledPatch; after: SourceEnabledPatch }

/** A preset receipt holds only the switches it actually changed, never keys or the whole config. */
export function sourcePresetUndo(config: FusionConfig, changes: SourceEnabledPatch): SourcePresetUndo | null {
  const before: SourceEnabledPatch = {};
  const after: SourceEnabledPatch = {};
  for (const [id, enabled] of Object.entries(changes) as [SourceId, boolean][]) {
    const previous = config.sources[id]?.enabled === true;
    if (previous !== enabled) { before[id] = previous; after[id] = enabled; }
  }
  return Object.keys(before).length ? { before, after } : null;
}

/** Preserve switches the user changed again after applying the preset. */
export function undoSourcePreset(config: FusionConfig, receipt: SourcePresetUndo): SourceEnabledPatch {
  return Object.fromEntries((Object.entries(receipt.before) as [SourceId, boolean][]).filter(([id]) => (config.sources[id]?.enabled === true) === receipt.after[id]));
}
