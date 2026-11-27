import path from 'node:path';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { root, removeOwned } from './lib.mjs';
import { readJson } from './release-common.mjs';

export async function retainArtifacts({
  repository = root,
  current,
  apply = false,
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
    for (const kind of ['playwright', 'tooling']) {
      const directory = path.join(repository, 'output', kind);
      if (!existsSync(directory)) continue;
      const records = [];
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const target = path.join(directory, entry.name);
        const summary = await readJson(path.join(target, 'summary.json'), null).catch(() => null);
        const time = Date.parse(summary?.finishedAt);
        if (target === current || !Number.isFinite(time)) {
          result.protected.push(target);
          continue;
        }
        records.push({ target, passed: summary.status === 'PASS', time });
      }
      for (const passed of [true, false]) {
        const ordered = records
          .filter((record) => record.passed === passed)
          .sort((a, b) => b.time - a.time || a.target.localeCompare(b.target));
        const limit = passed ? keepPassed : keepFailed;
        result.protected.push(...ordered.slice(0, limit).map((record) => record.target));
        for (const record of ordered.slice(limit)) {
          result.candidates.push(record.target);
          if (!apply) continue;
          try {
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
