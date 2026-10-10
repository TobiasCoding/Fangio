import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['fake-indexeddb/auto'],
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
