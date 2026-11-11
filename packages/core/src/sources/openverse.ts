import { fetchJson } from '../http';
import type { SearchHit, SearchSource } from '../types';

interface OpenverseImage {
  title?: string | null;
  url: string;
  thumbnail?: string | null;
  foreign_landing_url?: string | null;
  creator?: string | null;
  license?: string | null;
  license_version?: string | null;
  width?: number | null;
  height?: number | null;
  provider?: string | null;
}

export function licenseLabel(license: string | null | undefined, version: string | null | undefined): string | undefined {
  if (!license) return undefined;
  if (license === 'cc0') return 'CC0';
  if (license === 'pdm') return 'Public Domain';
  return `CC ${license.toUpperCase()}${version ? ` ${version}` : ''}`;
}

/**
 * Openly licensed images. Anonymous access is capped at 20 results per page, 20 requests a
 * minute and 200 a day, which the shared source cache is there to stretch.
 * https://api.openverse.org/v1/
 */
export const openverse: SearchSource = {
  id: 'openverse',
  label: 'Openverse',
  modes: ['images'],
  requiresKey: false,
  async search(query, { env, count, signal }) {
    const params = new URLSearchParams({ q: query, page_size: String(Math.min(count, 20)) });
    const data = await fetchJson<{ results?: OpenverseImage[] }>(env.fetch, `https://api.openverse.org/v1/images/?${params}`, { signal });
    const hits: SearchHit[] = [];
    for (const image of data.results ?? []) {
      if (!image.url) continue;
      hits.push({
        url: image.foreign_landing_url || image.url,
        title: image.title?.trim() || '(untitled)',
        snippet: image.creator ? `${image.creator}` : '',
        meta: { siteName: image.provider ?? undefined },
        image: {
          src: image.url,
          thumbnail: image.thumbnail || image.url,
          width: image.width ?? undefined,
          height: image.height ?? undefined,
          license: licenseLabel(image.license, image.license_version),
          creator: image.creator ?? undefined,
        },
        source: 'openverse',
        rank: hits.length + 1,
      });
    }
    return hits.slice(0, count);
  },
};
