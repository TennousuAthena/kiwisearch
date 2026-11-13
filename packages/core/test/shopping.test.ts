import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { amazon, jd, taobao } from '../src/engines/shopping';

const dom = (html: string): ParentNode => {
  const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigation: { disableChildFrameNavigation: true } } });
  window.document.write(html);
  return window.document as unknown as ParentNode;
};
const fixture = (id: string) => dom(readFileSync(new URL(`./fixtures/${id}.html`, import.meta.url), 'utf8'));

describe('shopping engines', () => {
  for (const engine of [taobao, jd, amazon]) {
    it(`${engine.id} searches only shopping and encodes queries`, () => {
      const url = new URL(engine.buildUrl('咖啡 & a+b?#', 12, 'shopping'));
      expect(url.searchParams.get(engine.id === 'amazon' ? 'k' : engine.id === 'jd' ? 'keyword' : 'q')).toBe('咖啡 & a+b?#');
      expect(engine.modes).toEqual(['shopping']);
    });
  }

  it('reads live Amazon products, preserving the observed currency and accessible price once', () => {
    const doc = fixture('amazon');
    const hits = amazon.extract(doc, 'https://www.amazon.com/s?k=coffee', 'shopping');
    expect(hits).toHaveLength(8);
    expect(hits[0]).toMatchObject({
      url: 'https://www.amazon.com/dp/B005EPRFKO',
      title: 'Hamilton Beach Fresh Grind Electric Coffee Grinder For Up To 12 Cups',
      product: { price: 'GBP 15.13', rating: '4.5 out of 5 stars', sales: '10K+ bought in past month', thumbnail: 'https://m.media-amazon.com/images/I/61EJRxaGwvL._AC_UL320_.jpg' },
    });
    expect(hits[0].snippet).toContain('Stainless Steel Blades');
    expect(doc.querySelector(amazon.readySelector)).not.toBeNull();
    expect(doc.querySelector(amazon.blockedSelector)).toBeNull();
  });

  it('reads the real wireless-headphone layout captured from the minimized worker', () => {
    const hits = amazon.extract(fixture('amazon-wireless'), 'https://www.amazon.com/s?k=wireless+headphones', 'shopping');
    expect(hits).toHaveLength(8);
    expect(hits[0]).toMatchObject({
      url: 'https://www.amazon.com/dp/B0HFM63KVW',
      title: 'Hybrid Active Noise Cancelling Bluetooth Headphones Wireless Headphones',
      product: { price: 'GBP 23.09', rating: '4.4 out of 5 stars', sales: '2K+ bought in past month' },
    });
  });

  it('parses the hand-written Taobao bundle-derived card, keeps its SKU and price condition', () => {
    const hits = taobao.extract(fixture('taobao'), taobao.buildUrl('coffee', 12, 'shopping'), 'shopping');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ url: 'https://item.taobao.com/item.htm?id=100000000001&skuId=200000000001', title: '手动咖啡磨豆机', product: { price: '¥129.00 券后', shop: '示例咖啡店', sales: '100+人付款' } });
    expect(hits[1].product?.price).toBeUndefined();
    expect(hits[1].url).toBe('https://detail.tmall.com/item.htm?id=100000000002');
  });

  it('reads real Taobao product prices, shops and images, excluding sponsored redirect cards', () => {
    const hits = taobao.extract(fixture('taobao-live'), 'https://s.taobao.com/search', 'shopping');
    expect(hits).toHaveLength(10);
    expect(hits[0]).toMatchObject({
      url: 'https://item.taobao.com/item.htm?id=991769649087&skuId=5961756992245',
      title: '惠普头戴式电脑耳机教考考试中高学生网课学习听力听说专用耳麦',
      product: { price: '¥24.2 优惠后', shop: '欧鑫品牌数码折扣店', sales: '1000+人付款' },
    });
    expect(hits.every((hit) => hit.product?.thumbnail?.startsWith('https://'))).toBe(true);
    expect(hits.every((hit) => !!hit.product?.shop)).toBe(true);
  });

  it('reads the real primary Taobao mainImg before the later mainPic duplicate exists', () => {
    const doc = fixture('taobao-live');
    const expected = taobao.extract(doc, 'https://s.taobao.com/search', 'shopping').map((hit) => hit.product?.thumbnail);
    doc.querySelectorAll('img[class*="mainPic--"]').forEach((image) => image.remove());
    const hits = taobao.extract(doc, 'https://s.taobao.com/search', 'shopping');
    expect(hits.map((hit) => hit.product?.thumbnail)).toEqual(expected);
    expect(hits).toHaveLength(10);
  });

  it('parses hand-written JD cards, without converting review counts into sales or inventing prices', () => {
    const hits = jd.extract(fixture('jd'), jd.buildUrl('coffee', 12, 'shopping'), 'shopping');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ url: 'https://item.jd.com/100000000001.html', title: '手动咖啡磨豆机', product: { price: '￥139.00', shop: '示例京东自营店', thumbnail: 'https://img10.360buyimg.com/example-grinder.jpg' } });
    expect(hits[0].product?.sales).toBeUndefined();
    expect(hits[1].product?.price).toBeUndefined();
  });

  for (const engine of [taobao, jd]) {
    it(`${engine.id} recognizes its real login wall without confusing it with a captcha`, () => {
      const doc = fixture(`${engine.id}-blocked`);
      expect(doc.querySelector(engine.loginSelector!)).not.toBeNull();
      expect(doc.querySelector(engine.blockedSelector)).toBeNull();
      expect(engine.extract(doc, engine.buildUrl('coffee', 12, 'shopping'), 'shopping')).toEqual([]);
    });
  }

  it('ignores optional sign-in links and captcha SDK preloads', () => {
    const doc = dom('<a href="https://login.taobao.com/member/login.jhtml">Sign in</a><a href="https://passport.jd.com/new/login.aspx">Sign in</a><a href="https://www.amazon.com/ap/signin">Sign in</a><script src="https://example.com/captcha.js"></script>');
    for (const e of [taobao, jd, amazon]) {
      expect(doc.querySelector(e.blockedSelector)).toBeNull();
      if (e.loginSelector) expect(doc.querySelector(e.loginSelector)).toBeNull();
      expect(e.isLoginUrl?.(e.buildUrl('coffee', 12, 'shopping'))).toBe(false);
    }
    expect(taobao.isLoginUrl?.('https://login.taobao.com/member/login.jhtml')).toBe(true);
    expect(jd.isLoginUrl?.('https://passport.jd.com/new/login.aspx')).toBe(true);
    expect(amazon.isLoginUrl?.('https://www.amazon.com/ap/signin')).toBe(true);
    expect(amazon.isLoginUrl?.('https://www.amazon.com.evil.test/ap/signin')).toBe(false);
  });

  it('rejects unsafe, foreign, malformed and non-product Amazon links and deduplicates ASINs', () => {
    const card = (href: string, title = 'Product') => `<div data-component-type="s-search-result" data-asin="B005EPRFKO"><a href="${href}"><h2>${title}</h2></a><img class="s-image" src="javascript:bad"><span class="a-price a-text-price"><span class="a-offscreen">$200</span></span></div>`;
    const hits = amazon.extract(dom([
      '/name/dp/B005EPRFKO/ref=sr_1?tracking=1', '/dp/B005EPRFKO',
      'https://www.amazon.com.evil.test/dp/B005EPRFKO', 'javascript:bad',
      'https://user:secret@www.amazon.com/dp/B005EPRFKO', '/stores/example', '/dp/not-an-asin',
    ].map((href) => card(href)).join('') + card('/dp/B000000001', '')), 'https://www.amazon.com/s', 'shopping');
    expect(hits).toHaveLength(1);
    expect(hits[0].product?.thumbnail).toBeUndefined();
    expect(hits[0].product?.price).toBeUndefined();
  });

  it('preserves explicit Amazon seller/offer identities and bounds their size', () => {
    const card = (query: string) => `<div data-component-type="s-search-result" data-asin="B005EPRFKO"><a href="/dp/B005EPRFKO?${query}"><h2>Product</h2></a></div>`;
    const html = [card('smid=SELLER1'), card('smid=SELLER2'), card('smid=SELLER1&offerListingID=offer%2B1%3D'), card('smid='+'A'.repeat(65)+'&offerListingID='+'x'.repeat(2049))].join('');
    const hits = amazon.extract(dom(html), 'https://www.amazon.com/s', 'shopping');
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://www.amazon.com/dp/B005EPRFKO?smid=SELLER1',
      'https://www.amazon.com/dp/B005EPRFKO?smid=SELLER2',
      'https://www.amazon.com/dp/B005EPRFKO?smid=SELLER1&offerListingID=offer%2B1%3D',
      'https://www.amazon.com/dp/B005EPRFKO',
    ]);
  });

  it('rejects unsafe or foreign Taobao and JD product links and deduplicates tracking variants', () => {
    const taobaoCard = (href: string) => `<a class="doubleCardWrapperAdapt--test" href="${href}"><span class="title--test">Product</span></a>`;
    const tb = taobao.extract(dom(['https://item.taobao.com/item.htm?id=12&spm=1', 'https://item.taobao.com/item.htm?id=12&spm=2', 'https://item.taobao.com.evil.test/item.htm?id=13', 'https://item.taobao.com/item.htm?id=bad', 'javascript:bad', 'https://shop.taobao.com/item.htm?id=14'].map(taobaoCard).join('')), 'https://s.taobao.com/search', 'shopping');
    expect(tb.map((h) => h.url)).toEqual(['https://item.taobao.com/item.htm?id=12']);
    const jdCard = (href: string) => `<li class="gl-item"><div class="p-name"><a href="${href}"><em>Product</em></a></div></li>`;
    const j = jd.extract(dom('<div id="J_goodsList">'+['https://item.jd.com/12.html?tracking=1','https://item.jd.com/12.html','https://item.jd.com.evil.test/13.html','https://mall.jd.com/14.html','javascript:bad','https://item.jd.com/a.html'].map(jdCard).join('')+'</div>'), 'https://search.jd.com/Search', 'shopping');
    expect(j.map((h) => h.url)).toEqual(['https://item.jd.com/12.html']);
  });
});
