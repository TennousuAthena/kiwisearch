import { createHash } from 'node:crypto';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));

/** The search app is the home page; the introduction, install, getting-started and privacy pages are plain HTML, in Chinese and in English. */
const docs = ['about', 'install', 'start', 'privacy'];

/** The page's own files, kept so a repeat visit needs no network and the page opens when the site is down. */
function serviceWorkerSource(version: string, files: string[]): string {
  return `// Generated at build time. The shell cache is named by the build, so a new release replaces the old one.
const CACHE = 'kiwi-shell-${version}';
const FILES = ${JSON.stringify(files)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('kiwi-shell-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// The search page itself comes from the network when it can, so a new release shows up at once; the cached copy is for when it cannot.
// The other pages of the site are left to the network. Everything else the build names is cached and never changes (the names carry a hash).
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (url.pathname !== '/') return;
    event.respondWith(
      Promise.race([fetch(request), new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 3000))])
        .then((response) => {
          if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put('/', copy)); }
          return response;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
});
`;
}

/**
 * Writes `sw.js` once the build is on disk, from the files that are really there: the names in the bundle are not enough (Vite drops
 * the small chunks of HTML entries after `generateBundle`, and a file in the list that does not exist would fail the whole install).
 */
function shellServiceWorker(): Plugin {
  let outDir = '';
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
  return {
    name: 'kiwi-shell-service-worker',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() {
      if (!existsSync(join(outDir, 'index.html'))) throw new Error('The search page was not built; there is no shell to cache');
      // The shell is the search page and what it loads; the other pages are plain HTML and are not kept.
      const files = walk(outDir).map((file) => `/${relative(outDir, file).split(sep).join('/')}`)
        .filter((file) => file.startsWith('/assets/') || file === '/favicon.svg' || file === '/icon/32.png')
        .sort();
      const version = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 10);
      writeFileSync(join(outDir, 'sw.js'), serviceWorkerSource(version, ['/', ...files]));
    },
  };
}

export default defineConfig({
  plugins: [react(), shellServiceWorker()],
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: Object.fromEntries([
        ['index', here('./index.html')],
        ...docs.map((name) => [name, here(`./${name}.html`)]),
        ...docs.map((name) => [`en-${name}`, here(`./en/${name}.html`)]),
      ]),
    },
  },
});
