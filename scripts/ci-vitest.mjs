import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseShard, testFile } from './ci-summary.mjs';

// CI machines shard the files; each machine keeps the normal isolated, serial pool.
// Collect via Vitest itself so new files and configured exclusions need no manual list.
try {
  if (process.argv.length !== 3) throw new Error('Use node scripts/ci-vitest.mjs 1/4');
  const shard = process.argv[2];
  const { index } = parseShard(shard);
  const cli = path.resolve('node_modules/vitest/vitest.mjs');
  const collect = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, 'list', '--filesOnly', '--json', ...args], {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
    )
      .map((item) => testFile(item.file))
      .sort();
  const commit =
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const directory = path.resolve('output/ci');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, `vitest-${index}-inventory.json`),
    JSON.stringify(
      {
        commit,
        shard,
        node: process.version,
        platform: process.platform,
        allFiles: collect([]),
      },
      null,
      2
    ) + '\n'
  );
  const result = spawnSync(
    process.execPath,
    [
      cli,
      'run',
      `--shard=${shard}`,
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${path.join(directory, `vitest-${index}.json`)}`,
    ],
    { stdio: 'inherit', windowsHide: true, timeout: 1_800_000 }
  );
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
