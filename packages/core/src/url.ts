const TRACKING_PARAMS = [
  /^utm_/i,
  /^(fbclid|gclid|dclid|msclkid|msockid|yclid|mc_cid|mc_eid|igshid|spm|from|ref|ref_src|source|si)$/i,
];

/** Canonical form of a URL used to detect duplicates across engines. */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }
  const doi = extractDoi(u);
  if (doi) return `doi:${doi}`;
  let host = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
  if (host === 'arxiv.org') {
    const m = u.pathname.match(/^\/(?:abs|pdf|html)\/([\d.]+?)(?:v\d+)?(?:\.pdf)?$/);
    if (m) return `arxiv:${m[1]}`;
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

function extractDoi(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  if (host === 'doi.org' || host === 'dx.doi.org') {
    return decodeURIComponent(u.pathname.slice(1)).toLowerCase() || null;
  }
  return null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
