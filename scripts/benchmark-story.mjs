import path from 'node:path';
import { startVitest } from 'vitest/node';
import { root, newId } from './lib.mjs';

const file = 'tests/story-performance.manual.ts';
const directory = path.join(root, 'output', 'benchmarks', `story-${newId()}`);
process.env.UIMORI_BENCHMARK = '1';
process.env.UIMORI_ARTIFACT_DIR = directory;
const vitest = await startVitest('test', [file], { root, include: [file], watch: false });
await vitest?.close();
if (process.exitCode) throw new Error(`Story benchmark failed: ${file}`);
console.log(`Measurements: ${path.join(directory, 'story-performance.json')}`);
