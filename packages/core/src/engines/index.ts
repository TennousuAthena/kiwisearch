import type { BrowserEngine, SourceId } from '../types';
import { baidu } from './baidu';
import { baiduxueshu } from './baiduxueshu';
import { bilibili } from './bilibili';
import { bing } from './bing';
import { bravesearch } from './bravesearch';
import { cnki } from './cnki';
import { duckduckgo } from './duckduckgo';
import { douyin } from './douyin';
import { google } from './google';
import { kagi } from './kagi';
import { scholar } from './scholar';
import { yandex } from './yandex';
import { yuanbao } from './yuanbao';
import { sogou, weixin } from './sogou';
import { wos } from './wos';
import { x } from './x';
import { rednote, xiaohongshu } from './xiaohongshu';
import { youtube } from './youtube';
import { zhihu } from './zhihu';
import { makeBrowserSource } from './shared';
import { amazon, jd, taobao } from './shopping';

// Baidu stays last: the settings page lists the engines in this order.
export const BROWSER_ENGINES = { google, bing, duckduckgo, bravesearch, kagi, scholar, yandex, yuanbao, youtube, bilibili, douyin, zhihu, xiaohongshu, rednote, sogou, weixin, x, baiduxueshu, cnki, wos, taobao, jd, amazon, baidu } satisfies Record<string, BrowserEngine>;
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
export { bravesearch } from './bravesearch';
export { kagi } from './kagi';
export { scholar } from './scholar';
export { yandex } from './yandex';
export { youtube } from './youtube';
export { bilibili } from './bilibili';
export { douyin } from './douyin';
export { yuanbao } from './yuanbao';
export { zhihu } from './zhihu';
export { rednote, xiaohongshu } from './xiaohongshu';
export { sogou, weixin } from './sogou';
export { x } from './x';

export { amazon, jd, taobao } from './shopping';
