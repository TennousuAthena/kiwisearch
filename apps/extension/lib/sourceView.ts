import type { FusionConfig, SourceId } from '@kiwi-search/core';
import { t } from '@kiwi-search/app/i18n';
import { SOURCE_INFO } from './sourceCatalog';
import { ageLabel, type SourceHealth } from './sourceHealth';

export interface SourceBadge {
  tone: 'ok' | 'warn' | 'bad' | 'neutral';
  label: string;
  /** Smaller text beside the label: when, how many, why. */
  hint?: string;
  /** What the user can do about it from here: sign in, solve the captcha, fill in the key. */
  action?: 'login' | 'verify' | 'key';
}

/** The status shown next to a source on the settings page; null for a source that is switched off. */
export function describeSource(id: SourceId, config: FusionConfig, health?: SourceHealth, now = Date.now()): SourceBadge | null {
  const settings = config.sources[id];
  if (!settings?.enabled) return null;
  const info = SOURCE_INFO[id];
  if (info.key === 'required' && !settings.apiKey) return { tone: 'warn', label: t('options.sourceStatus.needsKey'), action: 'key' };
  if (info.baseUrl && !settings.baseUrl) return { tone: 'warn', label: t('options.sourceStatus.needsAddress'), action: 'key' };
  switch (health?.state) {
    case 'login':
      return { tone: 'warn', label: t('options.sourceStatus.needsLogin'), hint: t('options.sourceStatus.triedAgo', { ago: ageLabel(health.at, now) }), action: 'login' };
    case 'captcha':
      return { tone: 'warn', label: t('options.sourceStatus.captcha'), hint: t('options.sourceStatus.triedAgo', { ago: ageLabel(health.at, now) }), action: 'verify' };
    case 'error':
      return { tone: 'bad', label: t('options.sourceStatus.error'), hint: health.message };
    case 'ok':
      return { tone: 'ok', label: t('options.sourceStatus.ok'), hint: t('options.sourceStatus.okHint', { ago: ageLabel(health.at, now), count: health.count }) };
    case 'empty':
      return { tone: 'neutral', label: t('options.sourceStatus.empty'), hint: ageLabel(health.at, now) };
    default:
      return info.login
        ? { tone: 'neutral', label: t('options.sourceStatus.untried'), hint: t('options.sourceStatus.untriedHint'), action: 'login' }
        : { tone: 'neutral', label: t('options.sourceStatus.ready') };
  }
}
