// After a build: every file the service worker precaches must exist (one missing file fails its whole install and the offline shell is gone),
// and the pages the site promises must be there. Run: node scripts/check-dist.mjs
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const problems = [];
const need = (path, why) => { if (!existsSync(join(dist, path))) problems.push(`${path} is missing (${why})`); };

const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
const files = JSON.parse(/const FILES = (\[.*\]);/.exec(sw)?.[1] ?? 'null');
if (!files?.length) problems.push('sw.js has no file list');
for (const file of files ?? []) need(file === '/' ? 'index.html' : file.slice(1), 'in the service worker file list');
const pages = ['index', '404', 'about', 'install', 'start', 'privacy', 'en/about', 'en/install', 'en/start', 'en/privacy'];
for (const page of pages) need(`${page}.html`, page === '404' ? 'without it Cloudflare Pages answers every unknown path with the search page' : 'a page of the site');
for (const file of ['_headers', '_redirects', 'opensearch.xml', 'robots.txt', 'favicon.svg', 'mark.svg']) need(file, 'a static file of the site');

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`dist is complete: ${files.length} files in the service worker list, ${pages.length} pages`);
