import type { BrowserEngine, ProductInfo } from '../types';
import { absoluteHttpUrl, cleanText } from './shared';

function parsedHttpUrl(raw: string | null | undefined, base: string): URL | null {
  const absolute = absoluteHttpUrl(raw, base);
  if (!absolute) return null;
  const url = new URL(absolute);
  return url.username || url.password || url.port ? null : url;
}

function imageUrl(image: Element | null, base: string): string | undefined {
  for (const attr of ['data-lazy-img', 'data-src', 'src']) {
    const url = parsedHttpUrl(image?.getAttribute(attr), base);
    if (url) return url.href;
  }
  return undefined;
}

function matchesUrl(raw: string, hosts: string[], path: RegExp): boolean {
  const url = parsedHttpUrl(raw, 'https://invalid.invalid');
  return !!url && hosts.includes(url.hostname) && path.test(url.pathname);
}

function taobaoProductUrl(raw: string | null, base: string): string | null {
  const url = parsedHttpUrl(raw, base);
  if (!url || !['item.taobao.com', 'detail.tmall.com'].includes(url.hostname) || url.pathname !== '/item.htm') return null;
  const id = url.searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) return null;
  const target = new URL(`https://${url.hostname}/item.htm`);
  target.searchParams.set('id', id);
  // A specific SKU can have a different price; keep the variant the page linked to.
  const sku = url.searchParams.get('skuId');
  if (sku && /^\d+$/.test(sku)) target.searchParams.set('skuId', sku);
  return target.href;
}

// Current pc-search-2024 bundle (1.8.61, 2026-11-13). Class prefixes avoid tying
// the parser to a deployment's hash. taobao-live.html captures successful products
// from the user's worker tab without inferring its login identity.
const TAOBAO_CARDS = 'a[class*="doubleCardWrapperAdapt--"], a[class*="listCardWrapper--"]';

function taobaoPrice(card: Element): string | undefined {
  const unit = cleanText(card.querySelector('[class*="unit--"], [class*="unitListMod--"]'));
  const integer = cleanText(card.querySelector('[class*="priceInt--"], [class*="priceIntListMod--"]'));
  const fraction = cleanText(card.querySelector('[class*="priceFloat--"], [class*="priceFloatListMod--"]'));
  const number = integer ? `${unit}${integer}${fraction}` : cleanText(card.querySelector('[class*="price--"]'));
  if (!number) return undefined;
  const qualifier = cleanText(card.querySelector('[class*="priceDesc--"], [class*="suffixText--"]'));
  return [number, qualifier].filter(Boolean).join(' ');
}

export const taobao: BrowserEngine = {
  id: 'taobao',
  label: '淘宝',
  modes: ['shopping'],
  buildUrl: (query) => `https://s.taobao.com/search?q=${encodeURIComponent(query)}`,
  matches: ['*://s.taobao.com/*', '*://login.taobao.com/*'],
  readySelector: TAOBAO_CARDS,
  // A real same-URL login overlay; the ordinary header sign-in link is not a wall.
  loginSelector: '.J_MIDDLEWARE_FRAME_WIDGET iframe[src^="https://login.taobao.com/"], #baxia-dialog-content[src^="https://login.taobao.com/"]',
  isLoginUrl: (url) => matchesUrl(url, ['login.taobao.com'], /^\/member\/login\.jhtml/),
  blockedSelector: '#nc_1_wrapper, #nc_2_wrapper, #baxia-dialog-content[src*="/_____tmd_____/punish"]',
  isBlockedUrl: (url) => matchesUrl(url, ['s.taobao.com'], /^\/_____tmd_____\/punish/),
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const card of doc.querySelectorAll(TAOBAO_CARDS)) {
      const url = taobaoProductUrl(card.getAttribute('href'), pageUrl);
      const title = cleanText(card.querySelector('[class*="title--"], [class*="titleOneLine--"], [class*="listModTitle--"]'));
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      const product: ProductInfo = {
        thumbnail: imageUrl(card.querySelector('img[class*="mainImg--"], img[class*="mainPic--"], [class*="mainPic--"] img'), pageUrl),
        price: taobaoPrice(card),
        shop: cleanText(card.querySelector('[class*="shopNameText--"]')) || undefined,
        sales: cleanText(card.querySelector('[class*="realSales--"]')) || undefined,
      };
      hits.push({ url, host: new URL(url).hostname, title, snippet: '', rank: hits.length + 1, product });
    }
    return hits;
  },
};

function jdProductUrl(raw: string | null, base: string): string | null {
  const url = parsedHttpUrl(raw, base);
  if (!url || url.hostname !== 'item.jd.com') return null;
  const id = url.pathname.match(/^\/(\d+)\.html$/)?.[1];
  return id ? `https://item.jd.com/${id}.html` : null;
}

const JD_CARDS = '#J_goodsList .gl-item';

export const jd: BrowserEngine = {
  id: 'jd',
  label: '京东',
  modes: ['shopping'],
  buildUrl: (query) => `https://search.jd.com/Search?keyword=${encodeURIComponent(query)}&enc=utf-8`,
  matches: ['*://search.jd.com/*', '*://passport.jd.com/*', '*://safe.jd.com/*'],
  readySelector: `${JD_CARDS} .p-name a[href]`,
  loginSelector: '#formlogin, #smslogin',
  isLoginUrl: (url) => matchesUrl(url, ['passport.jd.com'], /^\/(?:new\/)?login\.aspx/),
  blockedSelector: '#JDJRV-wrap, .JDJRV-wrap, #captcha_body',
  isBlockedUrl: (url) => matchesUrl(url, ['safe.jd.com'], /^\//),
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const card of doc.querySelectorAll(JD_CARDS)) {
      const link = card.querySelector('.p-name a[href]');
      const url = jdProductUrl(link?.getAttribute('href') ?? null, pageUrl);
      const title = cleanText(link?.querySelector('em')) || cleanText(link);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      hits.push({
        url, host: 'item.jd.com', title, snippet: '', rank: hits.length + 1,
        product: {
          thumbnail: imageUrl(card.querySelector('.p-img img'), pageUrl),
          price: cleanText(card.querySelector('.p-price strong')) || undefined,
          shop: cleanText(card.querySelector('.p-shop a, .p-shopnum a')) || undefined,
          // p-commit is a review count, not a sales count or star rating.
        },
      });
    }
    return hits;
  },
};

function amazonProductUrl(raw: string | null, base: string): string | null {
  const url = parsedHttpUrl(raw, base);
  if (!url || !['www.amazon.com', 'amazon.com'].includes(url.hostname)) return null;
  const asin = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/)?.[1];
  if (!asin) return null;
  const target = new URL(`https://www.amazon.com/dp/${asin}`);
  // Different sellers/offers for an ASIN may have different prices. Keep the
  // explicit offer identity while discarding search/session tracking parameters.
  const seller = url.searchParams.get('smid');
  if (seller && /^[A-Za-z0-9]{1,64}$/.test(seller)) target.searchParams.set('smid', seller);
  const offer = url.searchParams.get('offerListingID');
  if (offer && offer.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(offer)) target.searchParams.set('offerListingID', offer);
  return target.href;
}

const AMAZON_CARDS = '[data-component-type="s-search-result"][data-asin]';

export const amazon: BrowserEngine = {
  id: 'amazon',
  label: 'Amazon',
  modes: ['shopping'],
  // Cold minimized worker tabs can stream this document for more than 35 seconds.
  minTimeoutMs: 60_000,
  buildUrl: (query) => `https://www.amazon.com/s?k=${encodeURIComponent(query)}`,
  matches: ['*://www.amazon.com/s*', '*://www.amazon.com/errors/*', '*://www.amazon.com/ap/*'],
  readySelector: `${AMAZON_CARDS} h2`,
  isLoginUrl: (url) => matchesUrl(url, ['www.amazon.com', 'amazon.com'], /^\/ap\/signin(?:\/|$)/),
  blockedSelector: '#captchacharacters, form[action="/errors/validateCaptcha"]',
  isBlockedUrl: (url) => matchesUrl(url, ['www.amazon.com', 'amazon.com'], /^\/errors\/validateCaptcha(?:\/|$)/),
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const card of doc.querySelectorAll(AMAZON_CARDS)) {
      const heading = card.querySelector('h2');
      const link = heading?.closest('a[href]') ?? heading?.querySelector('a[href]');
      const url = amazonProductUrl(link?.getAttribute('href') ?? null, pageUrl);
      const title = cleanText(heading);
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      // Read Amazon's accessible price once; the visual markup repeats it as parts.
      // Currency and price depend on the user's region, so never prepend a dollar.
      const price = cleanText(card.querySelector('.a-price:not(.a-text-price) .a-offscreen')) || undefined;
      const sales = Array.from(card.querySelectorAll('[data-cy="reviews-block"] span'))
        .map((span) => cleanText(span)).find((text) => /\bbought in (?:the )?past month\b/i.test(text));
      hits.push({
        url, host: 'amazon.com', title,
        snippet: cleanText(card.querySelector('.title-differentiators')),
        rank: hits.length + 1,
        product: {
          thumbnail: imageUrl(card.querySelector('img.s-image'), pageUrl),
          price, sales,
          rating: cleanText(card.querySelector('[data-cy="reviews-block"] .a-icon-alt')) || undefined,
        },
      });
    }
    return hits;
  },
};
