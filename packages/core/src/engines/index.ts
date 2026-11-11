import type { BrowserEngine, SourceId } from '../types';
import { baidu } from './baidu';
import { baiduxueshu } from './baiduxueshu';
import { bilibili } from './bilibili';
import { bing } from './bing';
import { cnki } from './cnki';
import { duckduckgo } from './duckduckgo';
import { google } from './google';
import { scholar } from './scholar';
import { yandex } from './yandex';
import { sogou, weixin } from './sogou';
import { wos } from './wos';
import { x } from './x';
import { rednote, xiaohongshu } from './xiaohongshu';
import { youtube } from './youtube';
import { zhihu } from './zhihu';
import { makeBrowserSource } from './shared';

// Baidu stays last: the settings page lists the engines in this order.
export const BROWSER_ENGINES = { google, bing, duckduckgo, scholar, yandex, youtube, bilibili, zhihu, xiaohongshu, rednote, sogou, weixin, x, baiduxueshu, cnki, wos, baidu } satisfies Record<string, BrowserEngine>;
export const browserSources = Object.fromEntries(
  Object.entries(BROWSER_ENGINES).map(([id, engine]) => [id, makeBrowserSource(engine)]),
) as Record<keyof typeof BROWSER_ENGINES, ReturnType<typeof makeBrowserSource>> as Record<SourceId, ReturnType<typeof makeBrowserSource>>;

export { baidu } from './baidu';
export { baiduxueshu } from './baiduxueshu';
export { cnki } from './cnki';
export { wos } from './wos';
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
