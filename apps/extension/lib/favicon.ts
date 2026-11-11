/**
 * Site icons for result headers, read from the site itself.
 *
 * Chrome's `_favicon` API only serves icons the browser already has from visits and bookmarks; for any other site it
 * answers with the same placeholder globe, so most results had no icon. The icon is therefore fetched here: `/favicon.ico`,
 * then the `<link rel="icon">` of the home page. Requests carry no cookies and no referrer, and nothing is trusted by its
 * content type: many sites answer a missing `/favicon.ico` with a 200 HTML page, so the bytes themselves are checked.
 */

export const MAX_ICON_BYTES = 100_000;
const MAX_HTML_BYTES = 200_000;
const REQUEST_TIMEOUT_MS = 4000;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Image type from the first bytes, or null when they are not an image format that works in an `<img>`. */
export function sniffImage(bytes: Uint8Array): string | null {
  const startsWith = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (startsWith(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  const head = new TextDecoder().decode(bytes.subarray(0, 1024));
  return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head) ? 'image/svg+xml' : null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** `data:` URL for image bytes, or null when they are not an image. */
export function imageDataUrl(bytes: Uint8Array): string | null {
  const type = sniffImage(bytes);
  return type ? `data:${type};base64,${toBase64(bytes)}` : null;
}

/** A public DNS name. Addresses, `localhost` and local-network names are never asked for an icon. */
export function fetchableHost(host: string): boolean {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || host.length > 253) return false;
  if (/^\d+(\.\d+)+$/.test(host)) return false;
  return !/\.(local|localhost|internal|lan|home|corp|intranet|test|invalid|example)$/.test(host) && !host.endsWith('.home.arpa');
}

/** Icon URLs a page declares, best first: a plain icon close to 32px, then the larger touch icons. */
export function iconLinks(html: string, baseUrl: string): string[] {
  const found: { url: string; rank: number }[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    }
    const rels = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const touch = rels.includes('apple-touch-icon') || rels.includes('apple-touch-icon-precomposed');
    if (!touch && !rels.includes('icon')) continue;
    const href = attrs.get('href')?.trim();
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || !fetchableHost(url.hostname)) continue;
    const sizes = (attrs.get('sizes') ?? '').toLowerCase();
    const size = sizes === 'any' ? 32 : Number(sizes.match(/(\d+)x\d+/)?.[1] ?? 16);
    found.push({ url: url.href, rank: (touch ? 1000 : 0) + Math.abs(size - 32) });
  }
  found.sort((a, b) => a.rank - b.rank);
  return [...new Set(found.map((link) => link.url))].slice(0, 3);
}

/** Read at most `max` bytes of a body; `truncated` says there was more. */
async function readBytes(response: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await response.arrayBuffer());
    return { bytes: all.subarray(0, max), truncated: all.length > max };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(total, max));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, max - offset);
    if (take <= 0) break;
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return { bytes, truncated: total > max };
}

/** The icon of `host` as a `data:` URL, or null when the site has none we can read. */
export async function fetchSiteIcon(host: string, fetchFn: FetchFn = (input, init) => fetch(input, init)): Promise<string | null> {
  if (!fetchableHost(host)) return null;
  const get = async (url: string): Promise<Response | null> => {
    try {
      const response = await fetchFn(url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // A redirect must not lead somewhere that is not a public site.
      if (!response.ok || (response.url && !fetchableHost(new URL(response.url).hostname))) return null;
      return response;
    } catch {
      return null;
    }
  };
  const loadIcon = async (url: string): Promise<string | null> => {
    const response = await get(url);
    if (!response) return null;
    try {
      const { bytes, truncated } = await readBytes(response, MAX_ICON_BYTES);
      return truncated || !bytes.length ? null : imageDataUrl(bytes);
    } catch {
      return null;
    }
  };

  const origin = `https://${host}`;
  const direct = await loadIcon(`${origin}/favicon.ico`);
  if (direct) return direct;
  const page = await get(`${origin}/`);
  if (!page) return null;
  let html: string;
  try {
    html = new TextDecoder().decode((await readBytes(page, MAX_HTML_BYTES)).bytes);
  } catch {
    return null;
  }
  for (const link of iconLinks(html, page.url || `${origin}/`)) {
    const icon = await loadIcon(link);
    if (icon) return icon;
  }
  return null;
}
