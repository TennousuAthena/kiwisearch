import { absoluteHttpUrl } from './shared';

/** Google embeds raster thumbnails in the rendered page. Never accept SVG, script or blob URLs. */
export function newsThumbnail(raw: string | null | undefined, pageUrl: string): string | undefined {
  if (!raw) return undefined;
  if (raw.length <= 250_000 && /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z\d+/=\s]+$/i.test(raw)) return raw;
  return absoluteHttpUrl(raw, pageUrl) ?? undefined;
}
