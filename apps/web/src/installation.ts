export type StoreId = 'chrome' | 'edge' | 'firefox';
export type BrowserId = StoreId | 'chromium' | 'brave' | 'opera';

/** Fill in each product listing URL after it is published. null keeps the store action unavailable. */
export const STORE_URLS: Record<StoreId, string | null> = {
  chrome: null,
  edge: null,
  firefox: null,
};

export const BROWSERS: readonly BrowserId[] = ['chrome', 'edge', 'firefox', 'chromium', 'brave', 'opera'];

export interface BrowserEnvironment {
  userAgent: string;
  userAgentData?: { brands: readonly { brand: string }[]; mobile?: boolean };
  maxTouchPoints?: number;
}

/** A local hint, not a compatibility guarantee. Unknown and mobile browsers get an explicit desktop choice. */
export function detectBrowser(env: BrowserEnvironment = globalThis.navigator ?? { userAgent: '' }): BrowserId | null {
  const ua = env.userAgent;
  if (env.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && (env.maxTouchPoints ?? 0) > 1)) return null;
  const brands = env.userAgentData?.brands.map(({ brand }) => brand.toLowerCase()) ?? [];
  if (/Edg\//.test(ua) || brands.includes('microsoft edge')) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/OPR\//.test(ua) || brands.includes('opera')) return 'opera';
  if (/Brave\//.test(ua) || brands.includes('brave')) return 'brave';
  if (/Chromium\//.test(ua)) return 'chromium';
  if (brands.includes('google chrome')) return 'chrome';
  if (brands.includes('chromium')) return 'chromium';
  if (/Chrome\//.test(ua)) return 'chrome';
  return null;
}

export function storeForBrowser(browser: BrowserId): StoreId {
  return browser === 'edge' || browser === 'firefox' ? browser : 'chrome';
}

export const RELEASES_URL = 'https://github.com/TennousuAthena/kiwisearch/releases';
/** GitHub resolves the current stable release, including its versioned asset names. */
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;

export function releasePackageForBrowser(browser: BrowserId): string {
  const target = storeForBrowser(browser);
  return `${target}-${target === 'firefox' ? 'mv2' : 'mv3'}.zip`;
}
