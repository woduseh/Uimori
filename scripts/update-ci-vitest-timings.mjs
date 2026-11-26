import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShard, testFile } from './ci-summary.mjs';

const ledgerFile = fileURLToPath(new URL('./ci-vitest-timings.json', import.meta.url));
const usage =
  'Usage: node scripts/update-ci-vitest-timings.mjs <artifact-directory> [--run <id>]... [--output <file> | --write]';
const artifactName = /^vitest-(\d+)(-inventory)?\.json$/u;
const windowsPath = /^[A-Za-z]:|\\/u;

export async function measureArtifacts(directory) {
  const inventories = new Map();
  const reports = new Map();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const match = entry.isFile() && artifactName.exec(entry.name);
    if (!match) continue;
    const target = match[2] ? inventories : reports;
    if (target.has(match[1]))
      throw new Error(`Duplicate artifact ${entry.name} under ${directory}`);
    target.set(
      match[1],
      JSON.parse(await readFile(path.join(entry.parentPath, entry.name), 'utf8'))
    );
  }
  const first = inventories.values().next().value;
  if (!first || !reports.size)
    throw new Error(`No Vitest shard inventory and report under ${directory}`);
  const total = parseShard(first.shard).total;
  for (const [index, inventory] of inventories) {
    if (inventory.platform !== 'linux')
      throw new Error(
        `Shard ${index} ran on ${inventory.platform ?? 'an unknown platform'}; timings come only from Linux CI`
      );
    const shard = parseShard(inventory.shard);
    if (
      shard.index !== Number(index) ||
      shard.total !== total ||
      inventory.commit !== first.commit ||
      JSON.stringify(inventory.allFiles) !== JSON.stringify(first.allFiles)
    )
      throw new Error(`Shard ${index} inventory differs from the other shards`);
  }
  const collected = new Set(first.allFiles);
  const seconds = {};
  for (const [index, report] of reports) {
    if (!inventories.has(index)) throw new Error(`Shard ${index} report has no inventory`);
    if (report.success !== true) throw new Error(`Shard ${index} did not pass`);
    for (const result of report.testResults ?? []) {
      if (windowsPath.test(result.name))
        throw new Error(`Shard ${index} reports a Windows path: ${result.name}`);
      const file = testFile(result.name);
      if (!collected.has(file))
        throw new Error(`Shard ${index} reports an uncollected file: ${file}`);
      if (file in seconds) throw new Error(`Duplicate timing for ${file}`);
      const elapsed = result.endTime - result.startTime;
      if (!(elapsed >= 0)) throw new Error(`Invalid timing for ${file}`);
      seconds[file] = Math.max(0.1, Math.round(elapsed / 100) / 10);
    }
  }
  return { commit: first.commit, allFiles: first.allFiles, seconds };
}

export function mergeTimings(ledger, measured, sourceRuns) {
  const seconds = {};
  for (const file of [...measured.allFiles].sort()) {
    const value = measured.seconds[file] ?? ledger.seconds[file];
    if (value !== undefined) seconds[file] = value;
  }
  return { sourceRuns, seconds };
}

export function formatLedger({ sourceRuns, seconds }) {
  const runs = sourceRuns.map((run) => JSON.stringify(run)).join(', ');
  const files = JSON.stringify(seconds, null, 2).replaceAll('\n', '\n  ');
  return `{\n  "sourceRuns": [${runs}],\n  "seconds": ${files}\n}\n`;
}

async function updateTimings(args) {
  const runs = [];
  let directory;
  let output;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--run' && /^\d+$/u.test(args[i + 1] ?? '')) runs.push(args[++i]);
    else if (arg === '--output' && args[i + 1] && output === undefined)
      output = path.resolve(args[++i]);
    else if (arg === '--write' && output === undefined) output = ledgerFile;
    else if (!arg.startsWith('--') && directory === undefined) directory = arg;
    else throw new Error(usage);
  }
  if (!directory) throw new Error(usage);
  if (output === ledgerFile && !runs.length)
    throw new Error(
      'Name the GitHub Actions run with --run <id> before writing the committed ledger'
    );
  const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
  const measured = await measureArtifacts(directory);
  const merged = mergeTimings(ledger, measured, runs);
  const removed = Object.keys(ledger.seconds).filter((file) => !(file in merged.seconds));
  console.error(
    `Measured ${Object.keys(measured.seconds).length} of ${measured.allFiles.length} collected files at ${measured.commit}; removed ${removed.length ? removed.join(', ') : 'none'}`
  );
  const text = formatLedger(merged);
  if (output) await writeFile(output, text);
  else process.stdout.write(text);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await updateTimings(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
