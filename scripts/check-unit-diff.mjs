import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { versionChanged } from './ci-changes.mjs';

const testFile = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:ts|tsx|mts|mjs|js)$/u;
const testCase =
  /^\s*(?:test|it)(?:\.(?:skip|only|todo|each|concurrent|fails|fixme|sequential))*\s*\(/gmu;
const disabledCase = /\b(?:test|it|describe|suite)(?:\.\w+)*\.(?:skip|only|todo|fixme)\b/gu;

export function checkUnitDiff({ base, allow, allowTestRemoval = false, cwd = process.cwd() }) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const list = (...args) =>
    git(...args, '-z')
      .split('\0')
      .filter(Boolean);
  const files = [
    ...new Set([
      ...list('diff', '--no-renames', '--name-only', base),
      ...list('ls-files', '--others', '--exclude-standard'),
    ]),
  ].sort();
  const before = (file) => {
    try {
      return git('show', `${base}:${file}`);
    } catch {
      return '';
    }
  };
  const after = (file) =>
    existsSync(path.join(cwd, file)) ? readFileSync(path.join(cwd, file), 'utf8') : '';
  const tests = files.filter((file) => testFile.test(file));
  const total = (read, pattern) =>
    tests.reduce((sum, file) => sum + (read(file).match(pattern)?.length ?? 0), 0);
  const cases = { before: total(before, testCase), after: total(after, testCase) };
  const disabled = { before: total(before, disabledCase), after: total(after, disabledCase) };
  const failures = [];
  const outside = files.filter((file) => !allow.some((glob) => path.posix.matchesGlob(file, glob)));
  if (outside.length) failures.push(`changed outside the allowed paths: ${outside.join(', ')}`);
  if (cases.after < cases.before && !allowTestRemoval)
    failures.push(
      `test cases fell from ${cases.before} to ${cases.after}; pass --allow-test-removal only when removing tests is the task`
    );
  if (disabled.after > disabled.before)
    failures.push(
      `skip, only, todo or fixme markers rose from ${disabled.before} to ${disabled.after}`
    );
  if (
    files.includes('package.json') &&
    versionChanged(
      (side) => (side === 'base' ? before('package.json') : after('package.json')) || '{}',
      'base',
      'worktree'
    )
  )
    failures.push('package.json version changed; a release is started by a person');
  return { files, cases, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    ({ values: options } = parseArgs({
      options: {
        base: { type: 'string' },
        allow: { type: 'string', multiple: true },
        'allow-test-removal': { type: 'boolean', default: false },
      },
    }));
    if (!options.base || !options.allow?.length) throw new Error('missing --base or --allow');
  } catch (error) {
    console.error(
      `${error.message}\nUsage: node scripts/check-unit-diff.mjs --base <ref> --allow <glob> [--allow <glob> ...] [--allow-test-removal]`
    );
    process.exit(2);
  }
  const result = checkUnitDiff({
    base: options.base,
    allow: options.allow,
    allowTestRemoval: options['allow-test-removal'],
  });
  for (const failure of result.failures) console.error(`FAIL ${failure}`);
  console.log(
    `check-unit-diff ${result.failures.length ? 'FAIL' : 'PASS'}: ${result.files.length} files, test cases ${result.cases.before} -> ${result.cases.after}`
  );
  process.exitCode = result.failures.length ? 1 : 0;
}
