import path from 'node:path';
import { root, newId, command, requireCommand } from './lib.mjs';

const directory = path.join(root, 'output', 'benchmarks', `story-${newId()}`);
const result = await command(
  ['node_modules/vitest/vitest.mjs', 'run', 'tests/story-performance.test.ts'],
  { env: { UIMORI_BENCHMARK: '1', UIMORI_ARTIFACT_DIR: directory } }
);
process.stdout.write(result.output);
requireCommand(result);
console.log(`Measurements: ${path.join(directory, 'story-performance.json')}`);
