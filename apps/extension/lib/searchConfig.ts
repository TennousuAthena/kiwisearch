import type { FusionConfig } from '@kiwi-search/core';

/**
 * The configuration one page searches with. The early overview sends events (a `phase` on every overview event, and
 * `summary_checked`) that a page has to know about: an unknown one used to clear the whole search of the website's page. A page says it
 * understands them with `phases` on its search request; any other page (the website before it was updated, an older extension page)
 * gets the single overview it has always had. The saved settings are not touched.
 */
export function configForPage(config: FusionConfig, pageUnderstandsPhases: boolean | undefined): FusionConfig {
  if (pageUnderstandsPhases || !config.summary.early.enabled) return config;
  return { ...config, summary: { ...config.summary, early: { ...config.summary.early, enabled: false } } };
}
