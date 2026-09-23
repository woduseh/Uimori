import path from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { root, removeOwned } from './lib.mjs';
import { releaseFingerprint, identityKey, readJson } from './release-common.mjs';

async function receiptProtections(repository) {
  const directory = path.join(repository, 'output/release/checks');
  if (!existsSync(directory)) return [];
  const identity = await releaseFingerprint(repository);
  const receipt = await readJson(path.join(directory, identityKey(identity), 'summary.json'), null);
  if (!receipt || JSON.stringify(receipt.identity) !== JSON.stringify(identity)) return [];
  const protectedPaths = [];
  for (const check of Object.values(receipt.checks ?? {})) {
    if (check.status !== 'PASS' || !check.log || !existsSync(check.log)) continue;
    // The receipt owns the check log. Its JSON result links the browser/tooling report.
    if (!path.resolve(check.log).startsWith(path.resolve(directory) + path.sep)) continue;
    for (const line of (await readFile(check.log, 'utf8')).split(/\r?\n/u)) {
      const tooling = /^Tooling tests PASS\. Report: (.+)$/.exec(line);
      if (tooling) protectedPaths.push(path.resolve(tooling[1]));
      try {
        const value = JSON.parse(line);
        for (const key of ['evidence', 'report'])
          if (typeof value[key] === 'string') protectedPaths.push(path.resolve(value[key]));
      } catch {
        /* Human-readable progress lines do not contain report references. */
      }
    }
  }
  return protectedPaths;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/** Return a plan by default. Delete only finished runs created by these verification tools. */
export async function retainArtifacts({
  repository = root,
  current,
  apply = false,
  protectedPaths,
  isAlive = processAlive,
  keepPassed = 3,
  keepFailed = 5,
} = {}) {
  const result = {
    status: apply ? 'PASS' : 'PLAN',
    removed: [],
    candidates: [],
    protected: [],
    warnings: [],
  };
  try {
    if (![keepPassed, keepFailed].every((value) => Number.isInteger(value) && value >= 1))
      throw new Error('Keep counts must be positive integers');
    protectedPaths ??= await receiptProtections(repository);
    for (const kind of ['playwright', 'tooling']) {
      const directory = path.join(repository, 'output', kind);
      if (!existsSync(directory)) continue;
      const records = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const owner = await readJson(path.join(target, 'ownership.json'), null);
        const summary = await readJson(path.join(target, 'summary.json'), null);
        const completed =
          owner?.active === false &&
          owner.directory === target &&
          owner.runId === entry.name &&
          Number.isInteger(owner.ownerPid) &&
          owner.ownerPid > 0 &&
          !isAlive(owner.ownerPid) &&
          ['PASS', 'FAIL', 'BLOCKED'].includes(summary?.status) &&
          owner.cleanup?.status === 'PASS' &&
          Number.isFinite(Date.parse(summary.finishedAt));
        const referenced = protectedPaths.some(
          (file) => file === target || file.startsWith(target + path.sep)
        );
        if (!completed || target === current || referenced) {
          result.protected.push(target);
          continue;
        }
        records.push({ target, status: summary.status, time: Date.parse(summary.finishedAt) });
      }
      for (const success of [true, false]) {
        const ordered = records
          .filter((record) => (record.status === 'PASS') === success)
          .sort((a, b) => b.time - a.time || a.target.localeCompare(b.target));
        const limit = success ? keepPassed : keepFailed;
        result.protected.push(...ordered.slice(0, limit).map((record) => record.target));
        for (const record of ordered.slice(limit)) {
          result.candidates.push(record.target);
          if (!apply) continue;
          try {
            // Recheck ownership immediately before removal; never kill any process.
            const owner = await readJson(path.join(record.target, 'ownership.json'));
            if (
              owner.active !== false ||
              owner.directory !== record.target ||
              isAlive(owner.ownerPid)
            )
              throw new Error('Run became active or changed ownership');
            await removeOwned(directory, record.target);
            result.removed.push(record.target);
          } catch (error) {
            result.warnings.push(`${record.target}: ${error.message}`);
          }
        }
      }
    }
  } catch (error) {
    result.warnings.push(error.message);
  }
  if (result.warnings.length) result.status = 'WARN';
  return result;
}
