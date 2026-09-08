import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { run } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fingerprint, json, newId, root } from './lib.mjs';

function eventJson(event) {
  return JSON.stringify(event, (_key, value) =>
    value instanceof Error
      ? {
          name: value.name,
          message: value.message,
          code: value.code,
          stack: value.stack,
          cause: value.cause,
        }
      : value
  );
}

async function defaultFiles() {
  const tests = (await readdir(path.join(root, 'tests')))
    .filter((name) => name.endsWith('.node.test.mjs'))
    .sort()
    .map((name) => path.join(root, 'tests', name));
  if (!tests.length) throw new Error('No tests/*.node.test.mjs files discovered');
  return [...tests, path.join(root, 'scripts', 'doctor.test.mjs')];
}

export async function testTooling(files) {
  const directory = path.join(root, 'output', 'tooling', newId());
  const report = path.join(directory, 'summary.json');
  const summary = {
    status: 'FAIL',
    scope:
      'Local tooling tests; process fault fixtures do not prove external process or browser access',
    runner: 'node:test',
    isolation: 'none',
    selection: files ? 'explicit-files' : 'default-tooling-files',
    startedAt: new Date().toISOString(),
    files: [],
    counts: null,
    report,
    log: path.join(directory, 'events.jsonl'),
  };
  const events = [];
  const terminalEvents = [];
  let aggregate;
  await json(report, summary);
  try {
    summary.files = (files ?? (await defaultFiles())).map((file) => path.resolve(root, file));
    if (!summary.files.length) throw new Error('No tooling test files selected');
    if (new Set(summary.files).size !== summary.files.length)
      throw new Error('Duplicate tooling test files selected');
    for (const file of summary.files) {
      if (!(await stat(file)).isFile()) throw new Error(`Tooling test file unavailable: ${file}`);
    }
    summary.sourceHash = (await fingerprint()).hash;
    // Explicit fault files may live outside the repository fingerprint inputs.
    const selectedHashes = () =>
      Promise.all(
        summary.files.map(async (file) => ({
          file,
          hash: createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
        }))
      );
    summary.selectedInputs = await selectedHashes();
    for await (const event of run({
      files: summary.files,
      cwd: root,
      isolation: 'none',
      timeout: 15000,
    })) {
      events.push(eventJson(event));
      if (event.type === 'test:summary' && !event.data.file) aggregate = event.data;
      if (event.type === 'test:pass' || event.type === 'test:fail') {
        const data = event.data;
        // Node 24 counts an empty module as a passing test named after the file.
        // Preserve that event, but never treat loading a file as an executed check.
        const fileLoadOnly = data.name === data.file && data.line === 1 && data.column === 1;
        const status = data.skip
          ? 'SKIPPED'
          : data.todo
            ? 'TODO'
            : event.type === 'test:pass'
              ? 'PASS'
              : 'FAIL';
        terminalEvents.push({
          name: data.name,
          status,
          file: data.file,
          type: data.details?.type,
          fileLoadOnly,
        });
        console.log(
          `${fileLoadOnly && status === 'PASS' ? 'FILE_LOAD_ONLY' : status} ${data.name}`
        );
        if (data.details?.error) console.error(data.details.error.message);
      }
    }
    summary.counts = aggregate?.counts ?? null;
    summary.tests = terminalEvents;
    const declaredTests = terminalEvents.filter(
      (event) => !event.fileLoadOnly && event.type !== 'suite'
    );
    summary.declaredTests = declaredTests.length;
    summary.filesWithoutTests = summary.files.filter(
      (file) => !declaredTests.some((event) => event.file === file)
    );
    const counts = summary.counts;
    if (!aggregate || !counts) throw new Error('Node test aggregate summary missing');
    if (
      !['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled'].every(
        (key) => Number.isInteger(counts[key]) && counts[key] >= 0
      )
    )
      throw new Error('Node test aggregate counts missing or invalid');
    if (!counts.tests || !declaredTests.length)
      throw new Error('Zero declared tests executed; file loading is not a test');
    if (summary.filesWithoutTests.length)
      throw new Error(
        `Selected files have no declared tests: ${summary.filesWithoutTests.join(', ')}`
      );
    if (
      !aggregate.success ||
      counts.failed ||
      counts.skipped ||
      counts.todo ||
      counts.cancelled ||
      counts.passed !== counts.tests ||
      terminalEvents.some((event) => event.status !== 'PASS')
    )
      throw new Error(`Required tooling tests did not all PASS: ${eventJson(counts)}`);
    if (
      summary.sourceHash !== (await fingerprint()).hash ||
      JSON.stringify(summary.selectedInputs) !== JSON.stringify(await selectedHashes())
    )
      throw new Error('Source or selected tests changed during tooling verification');
    summary.identityVerifiedAt = new Date().toISOString();
    summary.status = 'PASS';
  } catch (error) {
    summary.error = error.message;
    events.push(eventJson({ type: 'runner:error', data: error }));
    console.error(summary.error);
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.elapsedMs = Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
    await writeFile(summary.log, events.join('\n') + '\n');
    await json(report, summary);
    console.log(`Tooling tests ${summary.status}. Report: ${report}`);
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (
    args.length &&
    (args[0] !== '--files' || args.length < 2 || args.slice(1).some((arg) => arg.startsWith('--')))
  ) {
    console.error('Usage: node scripts/test-tooling.mjs [--files <file> ...]');
    process.exitCode = 1;
  } else {
    const summary = await testTooling(args.length ? args.slice(1) : undefined);
    if (summary.status !== 'PASS') process.exitCode = 1;
  }
}
