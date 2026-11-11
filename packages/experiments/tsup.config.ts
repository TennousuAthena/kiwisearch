import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  // core ships TypeScript source, so it has to be bundled rather than imported at runtime.
  noExternal: ['@kiwi-search/core'],
});
