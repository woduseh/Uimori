import path from 'node:path';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import {
  root,
  newId,
  command,
  requireCommand,
  fingerprint,
  distHash,
  json,
  ownedPath,
  removeOwned,
} from './lib.mjs';

// Compile beside dist so relative source-map paths remain valid after promotion.
// A failed compiler must never erase the last usable build.
export async function build({
  cwd = root,
  run = command,
  move = rename,
  progress = console.log,
} = {}) {
  const runId = `build-${newId()}`;
  const directory = path.join(cwd, 'output', 'build', runId);
  const candidate = ownedPath(cwd, path.join(cwd, `.build-${runId}`));
  const previous = ownedPath(cwd, path.join(cwd, `.build-${runId}-previous`));
  const dist = ownedPath(cwd, path.join(cwd, 'dist'));
  const lockPath = path.join(cwd, 'output', 'build', 'active.json');
  const summaryFile = path.join(directory, 'summary.json');
  const summary = {
    status: 'FAIL',
    runId,
    startedAt: new Date().toISOString(),
    node: process.version,
    steps: [],
    failures: [],
    cleanup: { status: 'NOT_RUN' },
    evidence: summaryFile,
  };
  let lock;
  let priorHash;
  let promoted = false;
  let movedPrevious = false;
  await mkdir(directory, { recursive: true });
  try {
    try {
      lock = await open(lockPath, 'wx');
      await lock.writeFile(JSON.stringify({ pid: process.pid, runId, candidate, previous }));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = JSON.parse(await readFile(lockPath, 'utf8'));
      throw new Error(
        `Build lock exists (PID ${owner.pid}, run ${owner.runId}). Check that process before removing ${lockPath}; inspect its summary and staging paths after an interrupted build.`
      );
    }
    if (existsSync(dist) && (await lstat(dist)).isSymbolicLink())
      throw new Error('Refusing to replace a symlink/junction dist');
    priorHash = existsSync(dist) ? await distHash(dist) : null;
    summary.previousDistHash = priorHash;
    const before = await fingerprint(cwd);
    await mkdir(candidate);
    for (const [name, args] of [
      [
        'server',
        ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json', '--outDir', candidate],
      ],
      ['web', ['node_modules/vite/bin/vite.js', 'build', '--outDir', path.join(candidate, 'web')]],
    ]) {
      progress(`Build ${name}; log: ${path.join(directory, `${name}.log`)}`);
      const step = { name, status: 'FAIL', log: `${name}.log` };
      summary.steps.push(step);
      try {
        const result = await run(args, {
          cwd,
          log: path.join(directory, step.log),
          timeout: 120000,
        });
        const { output, ...record } = result;
        Object.assign(step, record);
        if (output) progress(output);
        requireCommand(result);
        step.status = 'PASS';
      } catch (error) {
        step.error = error.message;
        step.errorCode = error.code;
        if (error.code === 'EPERM' || /spawn EPERM/u.test(error.message)) step.status = 'BLOCKED';
        // spawn can throw before command() creates the log.
        if (!existsSync(path.join(directory, step.log)))
          await writeFile(path.join(directory, step.log), error.message + '\n');
        throw error;
      }
    }
    const after = await fingerprint(cwd);
    if (before.hash !== after.hash)
      throw new Error('Source changed while building; rerun after edits finish.');
    for (const file of ['server/index.js', 'web/index.html'])
      if (!existsSync(path.join(candidate, file))) throw new Error(`Build output missing: ${file}`);
    const manifest = {
      buildId: after.hash,
      sourceHash: after.hash,
      distHash: await distHash(candidate),
      builtAt: new Date().toISOString(),
      inputs: after.files,
      lineEndings: after.lineEndings,
      node: process.version,
    };
    await json(path.join(candidate, 'build-identity.json'), manifest);
    if (existsSync(dist)) {
      await move(dist, previous);
      movedPrevious = true;
    }
    try {
      await move(candidate, dist);
      promoted = true;
    } catch (error) {
      if (movedPrevious) {
        try {
          await move(previous, dist);
          movedPrevious = false;
        } catch (rollbackError) {
          summary.failures.push(`Rollback: ${rollbackError.message}`);
        }
      }
      throw error;
    }
    summary.identity = manifest;
    summary.status = 'PASS';
  } catch (error) {
    summary.failures.push(error.message);
    summary.status =
      error.code === 'EPERM' || /spawn EPERM/u.test(error.message) ? 'BLOCKED' : 'FAIL';
  } finally {
    const errors = [];
    if (lock) {
      // If promotion and rollback both failed, retain the previous build and lock for recovery.
      const recoveryRequired = movedPrevious && !promoted;
      for (const target of [candidate, ...(recoveryRequired ? [] : [previous])])
        try {
          await removeOwned(cwd, target);
        } catch (error) {
          errors.push(error.message);
        }
      await lock.close();
      if (recoveryRequired) errors.push(`Previous build retained at ${previous}; lock retained`);
      else
        try {
          await unlink(lockPath);
        } catch (error) {
          errors.push(error.message);
        }
      if (!promoted && priorHash !== undefined)
        summary.previousBuildPreserved =
          priorHash === null ? !existsSync(dist) : priorHash === (await distHash(dist));
    }
    summary.cleanup = { status: errors.length ? 'FAIL' : 'PASS', errors };
    if (errors.length) {
      summary.status = 'FAIL';
      summary.failures.push(...errors.map((error) => `Cleanup: ${error}`));
    }
    summary.finishedAt = new Date().toISOString();
    summary.elapsedMs = Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
    await json(summaryFile, summary);
  }
  return summary;
}
