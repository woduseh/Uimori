import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { distTests, listSelection } from './check-changed.mjs';
import { parseShard, testFile } from './ci-summary.mjs';
import { balanceTestFiles } from './ci-vitest-sequencer.ts';

const usage =
  'Use node scripts/ci-vitest.mjs <index>/<count> [--exclude-dist | --dist-only] [--impact-base <revision>]';

export function parseArguments(argv) {
  let shard;
  let dist = 'include';
  let impactBase;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--exclude-dist' || argument === '--dist-only') {
      if (dist !== 'include') throw new Error(usage);
      dist = argument === '--dist-only' ? 'only' : 'exclude';
    } else if (argument === '--impact-base') {
      impactBase = argv[++index];
      if (!impactBase || impactBase.startsWith('-')) throw new Error(usage);
    } else if (argument.startsWith('-') || shard !== undefined) throw new Error(usage);
    else shard = argument;
  }
  if (shard === undefined) throw new Error(usage);
  return { shard, ...parseShard(shard), dist, impactBase };
}

export function selectTests(allFiles, { dist = 'include', impact } = {}) {
  const affected = impact?.fullRequired.length
    ? undefined
    : impact && new Set(impact.affectedTests);
  const selected = allFiles.filter(
    (file) =>
      (!affected || affected.has(file)) &&
      (dist === 'include' || distTests.includes(file) === (dist === 'only'))
  );
  if (!affected && !selected.length)
    throw new Error(`ci-vitest: a full run (dist ${dist}) selected no test files`);
  const missingDist = distTests.filter((file) => !selected.includes(file));
  if (!affected && dist === 'only' && missingDist.length)
    throw new Error(`ci-vitest: distTests not collected: ${missingDist.join(', ')}`);
  return selected;
}

export function shardTests(files, { index, total }) {
  if (files.length < total) return files.slice(index - 1, index);
  return balanceTestFiles(files, total)[index - 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const cli = path.resolve('node_modules/vitest/vitest.mjs');
    const collected = JSON.parse(
      execFileSync(process.execPath, [cli, 'list', '--filesOnly', '--json'], {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
    )
      .map((item) => testFile(item.file))
      .sort();
    const impact = options.impactBase ? await listSelection(options.impactBase) : undefined;
    const allFiles = selectTests(collected, { dist: options.dist, impact });
    const files = shardTests(allFiles, options);
    const commit =
      process.env.GITHUB_SHA ??
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const directory = path.resolve('output/ci');
    const name = `vitest-${options.dist === 'only' ? 'dist-' : ''}${options.index}`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `${name}-inventory.json`),
      JSON.stringify(
        {
          commit,
          shard: options.shard,
          node: process.version,
          platform: process.platform,
          allFiles,
          files,
          selection: {
            dist: options.dist,
            impactBase: options.impactBase ?? null,
            scope: !impact ? 'full' : impact.fullRequired.length ? 'full-required' : 'impact',
            fullRequired: impact?.fullRequired ?? [],
          },
        },
        null,
        2
      ) + '\n'
    );
    if (impact?.fullRequired.length)
      console.log(
        `ci-vitest: full-required (${impact.fullRequired.join(', ')}); running every selected test`
      );
    if (!files.length) {
      console.log(`ci-vitest: no tests selected for shard ${options.shard}`);
    } else {
      const result = spawnSync(
        process.execPath,
        [
          cli,
          'run',
          '--reporter=default',
          '--reporter=json',
          `--outputFile=${path.join(directory, `${name}.json`)}`,
          ...files,
        ],
        { stdio: 'inherit', windowsHide: true, timeout: 1_800_000 }
      );
      if (result.error) console.error(result.error.message);
      process.exitCode = result.status ?? 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
