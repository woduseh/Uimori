import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

for (const [file, contract] of [
  [
    'oracle-update-test.py',
    'Oracle update validates inputs, switches safely and recovers from failures',
  ],
  [
    'oracle-gc-test.py',
    'Oracle retention preserves the recovery pair and never prunes unrelated services',
  ],
  [
    'oracle-status-test.py',
    'Oracle status preserves available recovery evidence when one lookup fails',
  ],
]) {
  test(contract, () => {
    const suite = fileURLToPath(new URL(`../deploy/${file}`, import.meta.url));
    const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', suite], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
