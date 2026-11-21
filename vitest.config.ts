import { availableParallelism, totalmem } from 'node:os';
import { defineConfig } from 'vitest/config';
import CiVitestSequencer from './scripts/ci-vitest-sequencer.js';

const localWorkers = Math.max(
  1,
  Math.min(Math.floor(availableParallelism() / 2), Math.floor(totalmem() / 2 ** 31))
);

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 15000,
    maxWorkers: process.env.CI !== 'true' ? localWorkers : process.platform === 'win32' ? 2 : 3,
    sequence: { sequencer: CiVitestSequencer },
    allowOnly: false,
  },
});
