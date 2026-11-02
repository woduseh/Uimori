import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// Historical Windows CI durations. Unknown/new files get a conservative default;
// no CI API call, cache write, or time-dependent scheduling during a run.
const timings = JSON.parse(
  readFileSync(new URL('./ci-vitest-timings.json', import.meta.url), 'utf8')
);
const defaultSeconds = 1;

export function balanceTestFiles(
  files: string[],
  count: number,
  seconds: Record<string, number> = timings.seconds
) {
  if (!Number.isInteger(count) || count < 1 || files.length < count)
    throw new Error('Each CI shard must contain at least one test file');
  if (new Set(files).size !== files.length)
    throw new Error('Duplicate test file in shard inventory');

  const shards: { files: string[]; seconds: number }[] = Array.from({ length: count }, () => ({
    files: [],
    seconds: 0,
  }));
  // Longest-processing-time first; identical names and weights get stable results.
  for (const file of [...files].sort((a, b) => {
    const diff = (seconds[b] ?? defaultSeconds) - (seconds[a] ?? defaultSeconds);
    return diff || a.localeCompare(b, 'en');
  })) {
    const target = shards.reduce((best, shard) =>
      shard.seconds < best.seconds ||
      (shard.seconds === best.seconds && shard.files.length < best.files.length)
        ? shard
        : best
    );
    target.files.push(file);
    target.seconds += seconds[file] ?? defaultSeconds;
  }
  return shards.map((shard) => shard.files);
}

export default class CiVitestSequencer extends BaseSequencer {
  async shard(specs: TestSpecification[]) {
    if (!this.ctx.config.shard) throw new Error('Vitest shard is required');
    const { index, count } = this.ctx.config.shard;
    const names = specs.map((spec) =>
      path.relative(this.ctx.config.root, spec.moduleId).replaceAll('\\', '/')
    );
    const selected = new Set(balanceTestFiles(names, count)[index - 1]);
    return specs.filter((_spec, i) => selected.has(names[i]));
  }
}
