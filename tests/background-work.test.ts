import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { expect, test } from 'vitest';

test('background terminal storage failure is observed and restart preserves uncertain work without replay', async () => {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, 'uimori-background-work-'));
  const target = resolve(directory),
    within = relative(root, target);
  if (
    isAbsolute(within) ||
    within.startsWith('..') ||
    !within.startsWith('uimori-background-work-')
  )
    throw new Error('Unsafe background fixture cleanup');
  try {
    const { localVerificationEnv } = await import(
      new URL('../scripts/lib.mjs', import.meta.url).href
    );
    const result = await promisify(execFile)(
      process.execPath,
      ['tests/fixtures/background-failure.mjs', join(directory, 'app.sqlite')],
      { env: localVerificationEnv(), timeout: 10000 }
    );
    const evidence = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)!);
    expect(evidence).toEqual({
      responseStatus: 200,
      failureWrites: 1,
      unhandledRejections: [],
      recoveredStatus: 'interrupted',
      attempts: 0,
    });
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
