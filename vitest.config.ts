import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 15000,
    // CI distributes files across independent runners; avoid contention inside each shard.
    fileParallelism: false,
    allowOnly: false,
  },
});
