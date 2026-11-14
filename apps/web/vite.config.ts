import { createHash } from 'node:crypto';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

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

// The page itself comes from the network when it can, so a new release shows up at once; the cached copy is for when it cannot.
// Everything else the build names is cached and never changes (the names carry a hash).
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
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

function shellServiceWorker(): Plugin {
  return {
    name: 'kiwi-shell-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const names = Object.keys(bundle).filter((name) => !name.endsWith('.map'));
      const files = ['/', ...names.filter((name) => name !== 'index.html').map((name) => `/${name}`), '/favicon.svg', '/icon/32.png'];
      const version = createHash('sha256').update(names.sort().join('|')).digest('hex').slice(0, 10);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource(version, files) });
    },
  };
}

export default defineConfig({
  plugins: [react(), shellServiceWorker()],
  build: { target: 'es2022', sourcemap: false },
});
