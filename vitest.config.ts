import { defineConfig } from 'vitest/config';
import CiVitestSequencer from './scripts/ci-vitest-sequencer.js';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 15000,
    fileParallelism: process.env.CI === 'true',
    maxWorkers: process.env.CI !== 'true' ? 1 : process.platform === 'win32' ? 2 : 3,
    sequence: { sequencer: CiVitestSequencer },
    allowOnly: false,
  },
});
