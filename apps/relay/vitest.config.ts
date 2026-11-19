import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test opens real WebSockets to a local workerd; starting it takes a few seconds.
    testTimeout: 20_000,
    hookTimeout: 120_000,
  },
});
