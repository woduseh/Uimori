import { defineConfig } from 'vitest/config';
import CiVitestSequencer from './scripts/ci-vitest-sequencer.js';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 15000,
    // CI distributes files across independent runners; avoid contention inside each shard.
    fileParallelism: process.env.CI === 'true',
    maxWorkers: process.env.CI === 'true' ? 2 : 1,
    sequence: { sequencer: CiVitestSequencer },
    allowOnly: false,
  },
});
