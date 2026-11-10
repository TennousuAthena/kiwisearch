import type { BrowserEngine, SourceId } from '../types';
import { baidu } from './baidu';
import { bing } from './bing';
import { duckduckgo } from './duckduckgo';
import { google } from './google';
import { scholar } from './scholar';
import { yandex } from './yandex';
import { makeBrowserSource } from './shared';

export const BROWSER_ENGINES = { google, bing, baidu, duckduckgo, scholar, yandex } satisfies Record<string, BrowserEngine>;
export const browserSources = Object.fromEntries(
  Object.entries(BROWSER_ENGINES).map(([id, engine]) => [id, makeBrowserSource(engine)]),
) as Record<keyof typeof BROWSER_ENGINES, ReturnType<typeof makeBrowserSource>> as Record<SourceId, ReturnType<typeof makeBrowserSource>>;

export { baidu } from './baidu';
export { bing, decodeBingUrl } from './bing';
export { google } from './google';
export { duckduckgo } from './duckduckgo';
export { scholar } from './scholar';
export { yandex } from './yandex';
