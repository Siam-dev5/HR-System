import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // integration tests start a local wrangler dev server with a fresh local D1
    testTimeout: 30_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
