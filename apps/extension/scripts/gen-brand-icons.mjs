// Regenerate committed browser icons from the single approved SVG, entirely offline.
// Run: pnpm --filter @kiwi-search/extension generate:brand
// Requires ImageMagick 7; set MAGICK_BIN when it is not on PATH. Normal builds use the committed outputs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extension = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(extension, '..', '..', 'design', 'brand', 'kiwi-green', 'mark.svg');
const output = join(extension, 'public');
const magick = process.env.MAGICK_BIN || 'magick';
const probe = spawnSync(magick, ['-version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  throw new Error('ImageMagick 7 is required to regenerate brand icons. Install it or set MAGICK_BIN to its magick executable.');
}

const svg = readFileSync(source, 'utf8');
const css = readFileSync(join(extension, 'lib', 'base.css'), 'utf8');
const accents = [...css.matchAll(/--accent:\s*(oklch\([^)]+\));/g)].map((match) => match[1]);
if (accents.length !== 2) throw new Error('Expected light and dark --accent tokens in lib/base.css.');

mkdirSync(join(output, 'icon'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const target = join(output, 'icon', `${size}.png`);
  const result = spawnSync(magick, [
    '-background', 'none', '-density', '768', source,
    '-filter', 'Lanczos', '-resize', `${size}x${size}`, '-strip', `PNG32:${target}`,
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Could not render ${size}px icon: ${result.stderr || result.error}`);
}

// SVG favicons can adapt to the browser's theme; PNG is the static fallback and manifest format.
const favicon = svg.replace('</title>', `</title>\n  <style>path{fill:${accents[0]}}@media(prefers-color-scheme:dark){path{fill:${accents[1]}}}</style>`);
writeFileSync(join(output, 'favicon.svg'), favicon);
console.log('Generated 16, 32, 48 and 128px PNG icons and the theme-aware SVG favicon.');
