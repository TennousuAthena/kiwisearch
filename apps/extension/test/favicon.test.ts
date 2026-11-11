import { describe, expect, it } from 'vitest';
import { MAX_ICON_BYTES, fetchSiteIcon, fetchableHost, iconLinks, imageDataUrl, sniffImage, type FetchFn } from '../lib/favicon';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16]);
const text = (value: string) => new TextEncoder().encode(value);
const reply = (body: Uint8Array | string, init: { status?: number; type?: string; url?: string } = {}): Response => {
  const response = new Response((typeof body === 'string' ? text(body) : body) as BodyInit, { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'application/octet-stream' } });
  if (init.url) Object.defineProperty(response, 'url', { value: init.url });
  return response;
};

/** A fake network: `routes` maps a URL to what it answers; anything else is a 404. Records every request. */
function network(routes: Record<string, () => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return routes[url]?.() ?? reply('not found', { status: 404 });
  };
  return { fetchFn, calls };
}

describe('image sniffing', () => {
  it('knows the image formats browsers show in an <img>, whatever content type the site claimed', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(ICO)).toBe('image/x-icon');
    expect(sniffImage(text('GIF89a....'))).toBe('image/gif');
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniffImage(text('<?xml version="1.0"?>\n<!-- made by hand -->\n<svg viewBox="0 0 1 1"/>'))).toBe('image/svg+xml');
  });

  it('refuses pages and junk, which sites often serve with 200 for a missing /favicon.ico', () => {
    expect(sniffImage(text('<!doctype html><html><head><title>Not found</title></head></html>'))).toBeNull();
    expect(sniffImage(text('<html><body><svg></svg></body></html>'))).toBeNull();
    expect(sniffImage(text('{"error":"not found"}'))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(imageDataUrl(text('<html></html>'))).toBeNull();
    expect(imageDataUrl(PNG)).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`);
  });
});

describe('which hosts are asked for an icon', () => {
  it('takes public names only: no addresses, localhost or local-network names', () => {
    for (const host of ['github.com', 'en.wikipedia.org', 'mp.weixin.qq.com', 'xn--fiq228c.com', 'a-b.co.uk']) expect(fetchableHost(host), host).toBe(true);
    for (const host of ['', 'localhost', '127.0.0.1', '192.168.1.5', '10.0.0.1', '[::1]', 'nas.local', 'router.home.arpa', 'wiki.internal', 'host:8080', 'bad host.com', '-a.com', 'a..com']) {
      expect(fetchableHost(host), host).toBe(false);
    }
  });
});

describe('icon links in a page', () => {
  const base = 'https://site.example.com/a/page';

  it('reads rel/href in any quoting and case, resolves them against the page, and prefers a plain icon near 32px', () => {
    const html = `<head>
      <LINK REL="apple-touch-icon" HREF="/touch.png" sizes="180x180">
      <link rel='shortcut icon' href='icons/32.png' sizes="32x32">
      <link rel=icon href=//cdn.example.org/16.png sizes=16x16>
      <link rel="icon" type="image/svg+xml" href="/logo.svg" sizes="any">
      <link rel="mask-icon" href="/mask.svg">
      <link rel="stylesheet" href="/site.css"></head>`;
    expect(iconLinks(html, base)).toEqual(['https://site.example.com/a/icons/32.png', 'https://site.example.com/logo.svg', 'https://cdn.example.org/16.png']);
  });

  it('falls back to touch icons, ignores non-https and non-public targets, and finds nothing in a page without icons', () => {
    expect(iconLinks('<link rel="apple-touch-icon" href="/t.png">', base)).toEqual(['https://site.example.com/t.png']);
    expect(iconLinks('<link rel="icon" href="http://site.example.com/i.png"><link rel="icon" href="https://127.0.0.1/i.png"><link rel="icon" href="data:image/png;base64,AAAA"><link rel="icon" href="">', base)).toEqual([]);
    expect(iconLinks('<html><body>no icons</body></html>', base)).toEqual([]);
  });
});

describe('fetching a site icon', () => {
  it('takes /favicon.ico when it is an image, asking without cookies or referrer', async () => {
    const { fetchFn, calls } = network({ 'https://github.com/favicon.ico': () => reply(ICO, { type: 'image/vnd.microsoft.icon' }) });
    expect(await fetchSiteIcon('github.com', fetchFn)).toBe(imageDataUrl(ICO));
    expect(calls.map((call) => call.url)).toEqual(['https://github.com/favicon.ico']);
    expect(calls[0].init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('does not take an HTML page served as /favicon.ico, and reads the page\'s own <link> instead', async () => {
    const { fetchFn, calls } = network({
      'https://shop.example.com/favicon.ico': () => reply('<!doctype html><title>Oops</title>', { type: 'text/html' }),
      'https://shop.example.com/': () => reply('<link rel="icon" href="/static/brand.png" sizes="32x32">', { type: 'text/html', url: 'https://shop.example.com/' }),
      'https://shop.example.com/static/brand.png': () => reply(PNG, { type: 'image/png' }),
    });
    expect(await fetchSiteIcon('shop.example.com', fetchFn)).toBe(imageDataUrl(PNG));
    expect(calls.map((call) => call.url)).toEqual(['https://shop.example.com/favicon.ico', 'https://shop.example.com/', 'https://shop.example.com/static/brand.png']);
  });

  it('resolves page links against the address the page finally came from', async () => {
    const { fetchFn } = network({
      'https://example.com/': () => reply('<link rel="icon" href="icon.png">', { url: 'https://www.example.com/en/' }),
      'https://www.example.com/en/icon.png': () => reply(PNG),
    });
    expect(await fetchSiteIcon('example.com', fetchFn)).toBe(imageDataUrl(PNG));
  });

  it('gives up with null, trying at most the first three declared icons, when nothing works', async () => {
    const links = [1, 2, 3, 4, 5].map((n) => `<link rel="icon" href="/i${n}.png" sizes="${n}x${n}">`).join('');
    const { fetchFn, calls } = network({ 'https://nothing.example.com/': () => reply(links, { url: 'https://nothing.example.com/' }) });
    expect(await fetchSiteIcon('nothing.example.com', fetchFn)).toBeNull();
    expect(calls).toHaveLength(2 + 3);
  });

  it('refuses oversized files, failed requests and redirects to non-public addresses', async () => {
    const big = new Uint8Array(MAX_ICON_BYTES + 10);
    big.set(PNG);
    const sizes = network({ 'https://big.example.com/favicon.ico': () => reply(big) });
    expect(await fetchSiteIcon('big.example.com', sizes.fetchFn)).toBeNull();

    const failing: FetchFn = async () => {
      throw new TypeError('network down');
    };
    expect(await fetchSiteIcon('down.example.com', failing)).toBeNull();

    const rebound = network({ 'https://evil.example.com/favicon.ico': () => reply(PNG, { url: 'http://192.168.0.1/favicon.ico' }) });
    expect(await fetchSiteIcon('evil.example.com', rebound.fetchFn)).toBeNull();
  });

  it('never contacts a host that is not a public name', async () => {
    const { fetchFn, calls } = network({});
    for (const host of ['localhost', '127.0.0.1', 'printer.local', '']) expect(await fetchSiteIcon(host, fetchFn)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
