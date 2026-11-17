import { defineConfig } from 'vitest/config';
import CiVitestSequencer from './scripts/ci-vitest-sequencer.js';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 15000,
    // CI distributes files across independent runners. Hosted Linux has 4 vCPUs; the
    // Windows lane keeps 2 workers to limit contention. Local runs stay serial.
    fileParallelism: process.env.CI === 'true',
    maxWorkers: process.env.CI !== 'true' ? 1 : process.platform === 'win32' ? 2 : 3,
    sequence: { sequencer: CiVitestSequencer },
    allowOnly: false,
  },
});
