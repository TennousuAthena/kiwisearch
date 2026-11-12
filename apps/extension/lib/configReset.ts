import { DEFAULT_CONFIG, type FusionConfig, type SourceId } from '@kiwi-search/core';

/** The default settings, with the keys and addresses the user typed kept: those are the part that is tedious to get back. */
export function resetKeepingSecrets(current: FusionConfig): FusionConfig {
  const next = structuredClone(DEFAULT_CONFIG);
  for (const [id, settings] of Object.entries(current.sources) as [SourceId, FusionConfig['sources'][SourceId]][]) {
    if (!settings?.apiKey && !settings?.baseUrl) continue;
    next.sources[id] = { ...(next.sources[id] ?? { enabled: false }), ...(settings.apiKey ? { apiKey: settings.apiKey } : {}), ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}) };
  }
  next.judge.apiKey = current.judge.apiKey;
  // A separate decision model the user filled in is as tedious to get back as any key.
  if (current.judge.llm.apiKey) next.judge.llm = { ...current.judge.llm };
  // The address of a decision-model service the user pointed Kiwi at is part of what is tedious to get back.
  next.judge.endpoint = current.judge.endpoint;
  next.llm.apiKey = current.llm.apiKey;
  if (current.rerank.apiKey) next.rerank.apiKey = current.rerank.apiKey;
  return next;
}

/** Drops the blank and repeated lines an older settings page could store in the rule and site lists. */
export function tidyConfig(config: FusionConfig): FusionConfig {
  const clean = (list: string[]) => [...new Set(list.map((item) => item.trim()).filter(Boolean))];
  return { ...config, judge: { ...config.judge, rules: clean(config.judge.rules), blockedDomains: clean(config.judge.blockedDomains), boostedDomains: clean(config.judge.boostedDomains) } };
}
