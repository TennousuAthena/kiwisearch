const TRACKING_PARAMS = [
  /^utm_/i,
  /^(fbclid|gclid|dclid|msclkid|msockid|yclid|mc_cid|mc_eid|igshid|spm|from|ref|ref_src|source|si)$/i,
];

/** Canonical form of a URL used to detect duplicates across engines. */
export function normalizeUrl(raw: string, contentIds = true): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }
  const doi = contentIds ? extractDoi(u) : undefined;
  if (doi) return `doi:${doi}`;
  let host = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
  const platform = contentIds ? videoKey(host, u) ?? noteKey(host, u) : undefined;
  if (platform) return platform;
  if (contentIds && host === 'arxiv.org') {
    const m = u.pathname.match(/^\/(?:abs|pdf|html)\/(.+?)(?:v\d+)?(?:\.pdf)?$/);
    if (m) return `arxiv:${m[1].toLowerCase()}`;
  }
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.some((re) => re.test(k)))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
  let path = u.pathname.replace(/\/+$/, '').replace(/\/index\.(html?|php)$/i, '');
  try {
    path = decodeURI(path);
  } catch {
    /* keep encoded */
  }
  return `${host}${path}${query}`;
}

/** Publisher pages that embed the DOI in the path (Springer, Wiley, T&F, ACM, ...) share a key with doi.org. */
const DOI_IN_PATH = /(10\.\d{4,9}\/[^\s?#]+)/;
const DOI_SUFFIX = /(?:\.pdf|\/(?:pdf|epdf|full|abstract|fulltext|references|citations))+$/i;

export /**
 * One video, many URL shapes: watch page, short link, Shorts, embed; a Bilibili video's parts (`?p=2`)
 * and its av/BV forms of the same page. Returns a stable key or null.
 */
function videoKey(host: string, u: URL): string | null {
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? `youtube:${id}` : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const id = u.pathname === '/watch' ? u.searchParams.get('v') : u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? `youtube:${id}` : null;
  }
  if (host === 'bilibili.com') {
    const id = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i)?.[1];
    return id ? `bilibili:${id.startsWith('BV') || id.startsWith('bv') ? `BV${id.slice(2)}` : id.toLowerCase()}` : null;
  }
  return null;
}

/** One Xiaohongshu note under either domain and any of its URL shapes: `xhs:<note id>`. */
function noteKey(host: string, u: URL): string | null {
  if (host !== 'xiaohongshu.com' && host !== 'rednote.com') return null;
  const id = u.pathname.match(/^\/(?:search_result|explore|discovery\/item)\/([0-9a-f]{24})(?:\/|$)/i)?.[1];
  return id ? `xhs:${id.toLowerCase()}` : null;
}

function extractDoi(u: URL): string | null {
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    path = u.pathname;
  }
  const host = u.hostname.toLowerCase();
  const raw = host === 'doi.org' || host === 'dx.doi.org' ? path.slice(1) : path.match(DOI_IN_PATH)?.[1];
  const doi = raw?.replace(DOI_SUFFIX, '').toLowerCase();
  return doi || null;
}

/** DOI of a paper URL, lower-cased, or undefined. */
export function doiFromUrl(raw: string): string | undefined {
  try {
    return extractDoi(new URL(raw)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
