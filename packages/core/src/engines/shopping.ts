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

function xianyuItemUrl(raw: string | null, base: string): string | null {
  const url = parsedHttpUrl(raw, base);
  if (!url || url.hostname !== 'www.goofish.com' || url.pathname !== '/item') return null;
  const id = url.searchParams.get('id');
  // The page adds `categoryId`, the category the item was listed in; it does not name the item and is dropped.
  return id && /^\d{6,24}$/.test(id) ? `https://www.goofish.com/item?id=${id}` : null;
}

// Xianyu's search page is a React app: the cards are drawn by the site's own components (xy-site 0.0.184, read from its public
// p_search-index.js and CSS on 2026-11-16), whose class names carry a build hash after `--`. Prefixes keep the parser off the hash.
// A card is one link: image, title, tags, price, who wants it, seller.
const XIANYU_CARDS = 'a[class*="feeds-item-wrap--"]';
// The site's image component first draws a loading picture and, once the card is on screen, the product's. A card that was never on
// screen (the minimized worker window) keeps only the placeholders, which are not photographs of the item.
const XIANYU_PLACEHOLDERS = ['O1CN01CYtPWu1MUBqQAUK9D', 'O1CN01KivsFV1LX78B1hnum'];

function xianyuPrice(card: Element): string | undefined {
  const wrap = card.querySelector('[class*="price-wrap--"]');
  const integer = cleanText(wrap?.querySelector('[class*="number--"], [class*="chinese--"]'));
  if (!wrap || !integer) return undefined;
  const sign = cleanText(wrap.querySelector('[class*="sign--"]'));
  // The cents, with or without the point depending on what the site sent.
  const cents = cleanText(wrap.querySelector('[class*="decimal--"]'));
  const decimal = /^\d+$/.test(cents) ? `.${cents}` : cents;
  // 万 and a unit such as 元/斤 follow the amount, outside the amount's own element.
  const magnitude = Array.from(card.querySelectorAll('[class*="magnitude--"]')).map((part) => cleanText(part)).join('');
  return `${sign}${integer}${decimal}${magnitude}`;
}

export const xianyu: BrowserEngine = {
  id: 'xianyu',
  label: '闲鱼',
  modes: ['shopping'],
  // Strict about frequent visits (its own risk control answers with a slider or a refusal): a gap well above the general one, as for X.
  minIntervalMs: 10_000,
  // A React app that signs its own API calls before the cards appear.
  minTimeoutMs: 30_000,
  buildUrl: (query) => `https://www.goofish.com/search?q=${encodeURIComponent(query)}`,
  matches: ['*://www.goofish.com/*', '*://passport.goofish.com/*'],
  readySelector: `${XIANYU_CARDS} [class*="main-title--"]`,
  // The site's own login (`/login?redirectURL=…`) and the mini-login frame it embeds (`passport.goofish.com/mini_login.htm`), both built by
  // functions in its bundle. Neither was seen on a live page: the one signed-out visit made for this was refused instead (see below).
  loginSelector: 'iframe[src*="passport.goofish.com/mini_login.htm"], iframe[src*="passport.goofish.com/login"]',
  isLoginUrl: (url) => matchesUrl(url, ['www.goofish.com'], /^\/login(?:\/|$)/) || matchesUrl(url, ['passport.goofish.com'], /^\/(?:mini_)?login\.htm/),
  // The page loads Alibaba's baxia library, the same one Taobao uses; the punish path is assumed to be the same too.
  blockedSelector: '#nc_1_wrapper, #nc_2_wrapper, #baxia-dialog-content[src*="/_____tmd_____/punish"]',
  isBlockedUrl: (url) => matchesUrl(url, ['www.goofish.com'], /^\/_____tmd_____\/punish/),
  // What a headless browser is shown instead of results (captured 2026-11-16). Nothing for the user to solve: the source fails with it.
  refusedPattern: /非法访问\s*为了保障您的体验，请使用正常浏览器访问闲鱼/,
  extract(doc, pageUrl) {
    const hits: ReturnType<BrowserEngine['extract']> = [];
    const seen = new Set<string>();
    for (const card of doc.querySelectorAll(XIANYU_CARDS)) {
      const url = xianyuItemUrl(card.getAttribute('href'), pageUrl);
      // The title is also the `title` attribute of its row, free of the badges drawn inside it.
      const heading = card.querySelector('[class*="row1-wrap-title--"]');
      const title = (heading?.getAttribute('title') ?? '').replace(/\s+/g, ' ').trim() || cleanText(card.querySelector('[class*="main-title--"]'));
      if (!url || !title || seen.has(url)) continue;
      seen.add(url);
      const photo = Array.from(card.querySelectorAll('img[class*="feeds-image--"]'))
        .map((image) => imageUrl(image, pageUrl))
        .filter((src): src is string => !!src && !XIANYU_PLACEHOLDERS.some((id) => src.includes(id)))
        .at(-1);
      // The item's condition and attributes ("256GB", "no repairs") and its service tags.
      const tags = [...card.querySelectorAll('span[class*="cpv--"]'), ...card.querySelectorAll('[class*="row2-wrap-service--"]')]
        .map((tag) => cleanText(tag)).filter(Boolean);
      // "3人想要" and the like: how many want the item, which is the nearest thing a second-hand listing has to sales.
      const wanted = Array.from(card.querySelectorAll('[class*="price-desc--"]')).map((part) => cleanText(part)).filter(Boolean).join(' · ');
      hits.push({
        url, host: 'www.goofish.com', title, snippet: tags.join(' · '), rank: hits.length + 1,
        product: {
          thumbnail: photo,
          price: xianyuPrice(card),
          shop: cleanText(card.querySelector('p[class*="seller-text--"]')) || undefined,
          sales: wanted || undefined,
        },
      });
    }
    return hits;
  },
};
