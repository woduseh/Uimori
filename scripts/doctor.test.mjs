import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { doctor, doctorStatus, probeNodeChild, supportedNode } from './doctor.mjs';
import { artifactRoot, newId, removeOwned } from './lib.mjs';

function childStub({ output = 'uimori-doctor-child-ready', code = 0, error, hang = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    queueMicrotask(() => {
      if (error) child.emit('error', error);
      else if (!hang) {
        child.stdout.write(output);
        child.emit('close', code, null);
      }
    });
    return child;
  };
}

test('doctor rejects unsupported Node minor, major, prerelease and malformed versions', () => {
  for (const version of ['24.14.0', 'v24.14.1', '24.99.0'])
    assert.equal(supportedNode(version), true);
  for (const version of ['24.13.9', '22.20.0', '25.0.0', '24.14', '24.14.0-rc.1', 'invalid'])
    assert.equal(supportedNode(version), false);
});

test('doctor status never promotes failed, blocked, unknown or required unrun checks to PASS', () => {
  assert.equal(doctorStatus([{ status: 'PASS' }, { status: 'BLOCKED' }]), 'BLOCKED');
  assert.equal(doctorStatus([{ status: 'BLOCKED' }, { status: 'FAIL' }]), 'FAIL');
  assert.equal(doctorStatus([{ status: 'NOT_RUN', required: true }]), 'BLOCKED');
  assert.equal(doctorStatus([{ status: 'PASS' }, { status: 'NOT_RUN', required: false }]), 'PASS');
  assert.equal(doctorStatus([{ status: 'skipped' }]), 'FAIL');
  assert.equal(doctorStatus([]), 'FAIL');
});

test('Node child probe requires the ready marker and successful exit', async () => {
  assert.deepEqual(await probeNodeChild({ spawnChild: childStub() }), {
    exitCode: 0,
    readyMarker: true,
    childClosed: true,
  });
  await assert.rejects(probeNodeChild({ spawnChild: childStub({ output: '' }) }), /marker missing/);
  await assert.rejects(probeNodeChild({ spawnChild: childStub({ code: 3 }) }), /code=3/);
  await assert.rejects(
    probeNodeChild({ spawnChild: childStub({ hang: true }), timeoutMs: 5 }),
    /timed out/
  );
});

test('blocked child preserves real SQLite, HTTP and cleanup evidence while explicit browser omission stays NOT_RUN', async () => {
  const directory = path.join(artifactRoot, `doctor-selftest-${newId()}`);
  try {
    const result = await doctor(directory, {
      browser: false,
      spawnChild: childStub({ error: Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }) }),
    });
    assert.equal(result.status, 'BLOCKED');
    assert.match(result.error, /node-child-ready-exit: spawn EPERM/);
    assert.equal(result.scope, 'api-environment');
    const checks = Object.fromEntries(result.checks.map((check) => [check.name, check]));
    assert.equal(checks['node-child-ready-exit'].status, 'BLOCKED');
    assert.equal(checks['node-child-ready-exit'].code, 'EPERM');
    assert.equal(checks['writable-directory'].status, 'PASS');
    assert.equal(checks['file-sqlite-transaction-reopen'].status, 'PASS');
    assert.equal(checks['localhost-bind-http'].status, 'PASS');
    assert.equal(checks['browser-launch-and-local-page'].status, 'NOT_RUN');
    assert.equal(checks['browser-launch-and-local-page'].required, false);
    assert.equal(result.cleanup.status, 'PASS');
    assert.equal(existsSync(path.join(directory, 'doctor-temp')), false);
    assert.deepEqual(JSON.parse(await readFile(result.report, 'utf8')), result);
    await assert.rejects(
      fetch(checks['localhost-bind-http'].url, { signal: AbortSignal.timeout(1000) })
    );
  } finally {
    if (existsSync(directory)) await removeOwned(artifactRoot, directory);
  }
});

test('unsupported runtime and malformed child output remain visible with independent real probes', async () => {
  const directory = path.join(artifactRoot, `doctor-selftest-${newId()}`);
  try {
    const result = await doctor(directory, {
      browser: false,
      nodeVersion: '24.13.9',
      spawnChild: childStub({ output: 'incorrect-ready' }),
    });
    const checks = Object.fromEntries(result.checks.map((check) => [check.name, check]));
    assert.equal(result.status, 'FAIL');
    assert.equal(checks['supported-node-runtime'].status, 'BLOCKED');
    assert.equal(checks['node-child-ready-exit'].status, 'FAIL');
    assert.equal(checks['file-sqlite-transaction-reopen'].status, 'PASS');
    assert.equal(checks['localhost-bind-http'].status, 'PASS');
    assert.equal(result.cleanup.status, 'PASS');
  } finally {
    if (existsSync(directory)) await removeOwned(artifactRoot, directory);
  }
});
