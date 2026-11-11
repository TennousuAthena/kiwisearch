import type { BrowserEngine, SourceId } from '../types';
import { baidu } from './baidu';
import { bilibili } from './bilibili';
import { bing } from './bing';
import { duckduckgo } from './duckduckgo';
import { google } from './google';
import { scholar } from './scholar';
import { yandex } from './yandex';
import { sogou, weixin } from './sogou';
import { x } from './x';
import { rednote, xiaohongshu } from './xiaohongshu';
import { youtube } from './youtube';
import { zhihu } from './zhihu';
import { makeBrowserSource } from './shared';

// Baidu stays last: the settings page lists the engines in this order.
export const BROWSER_ENGINES = { google, bing, duckduckgo, scholar, yandex, youtube, bilibili, zhihu, xiaohongshu, rednote, sogou, weixin, x, baidu } satisfies Record<string, BrowserEngine>;
export const browserSources = Object.fromEntries(
  Object.entries(BROWSER_ENGINES).map(([id, engine]) => [id, makeBrowserSource(engine)]),
) as Record<keyof typeof BROWSER_ENGINES, ReturnType<typeof makeBrowserSource>> as Record<SourceId, ReturnType<typeof makeBrowserSource>>;

export { baidu } from './baidu';
export { bing, decodeBingUrl } from './bing';
export { google, isGoogleGotoUrl } from './google';
export { duckduckgo } from './duckduckgo';
export { scholar } from './scholar';
export { yandex } from './yandex';
export { youtube } from './youtube';
export { bilibili } from './bilibili';
export { zhihu } from './zhihu';
export { rednote, xiaohongshu } from './xiaohongshu';
export { sogou, weixin } from './sogou';
export { x } from './x';
