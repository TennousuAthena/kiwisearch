import type { FusionConfig, SourceId } from '@kiwi-search/core';
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
  if (info.key === 'required' && !settings.apiKey) return { tone: 'warn', label: '需要 API Key', action: 'key' };
  if (info.baseUrl && !settings.baseUrl) return { tone: 'warn', label: '需要填写地址', action: 'key' };
  switch (health?.state) {
    case 'login':
      return { tone: 'warn', label: '需要登录', hint: `${ageLabel(health.at, now)}试过`, action: 'login' };
    case 'captcha':
      return { tone: 'warn', label: '遇到验证码', hint: `${ageLabel(health.at, now)}试过`, action: 'verify' };
    case 'error':
      return { tone: 'bad', label: '上次出错', hint: health.message };
    case 'ok':
      return { tone: 'ok', label: '可用', hint: `${ageLabel(health.at, now)} · ${health.count} 条` };
    case 'empty':
      return { tone: 'neutral', label: '上次没有结果', hint: ageLabel(health.at, now) };
    default:
      return info.login
        ? { tone: 'neutral', label: '还没试过', hint: '需要先在这个浏览器里登录', action: 'login' }
        : { tone: 'neutral', label: '已就绪' };
  }
}
