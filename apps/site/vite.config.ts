import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));

/** The pages of kiwi.moe: plain HTML, one style sheet, no framework and no script beyond importing the styles. */
const pages = ['index', 'install', 'start', 'privacy'];
export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      input: Object.fromEntries([
        ...pages.map((name) => [name, here(`./${name}.html`)]),
        ...pages.map((name) => [`en-${name}`, here(`./en/${name}.html`)]),
      ]),
    },
  },
});
