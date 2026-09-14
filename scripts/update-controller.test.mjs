import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  readJournal,
  requestCancel,
  runUpdate,
  updateEnvironment,
  validateConfig,
} from './update-controller.mjs';

const ENV = 'NR_PUBLIC_ORIGIN=https://story.example.test\nNR_ACCESS_TOKEN=secret-token\n';
function fixture() {
  const base = mkdtempSync(path.join(realpathSync(tmpdir()), 'uimori-update-'));
  const project = path.join(base, 'app');
  mkdirSync(project, { recursive: true });
  const composeFile = path.join(project, 'compose.yaml');
  writeFileSync(composeFile, 'services: {}\n');
  const envFile = path.join(project, '.env.self-host');
  writeFileSync(envFile, ENV);
  return {
    base,
    config: {
      composeFile,
      envFile,
      releaseRoot: path.join(base, 'releases'),
      dataVolume: 'uimori_data',
      image: 'ghcr.io/team/uimori:2026.9.14',
      appOrigin: 'https://story.example.test',
      drainTimeoutMs: 50,
    },
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function io({ work = [0], probe = '{"event":"ready"}', fail } = {}) {
  const calls = [];
  let time = 1_000;
  let index = 0;
  return {
    calls,
    io: {
      docker: (args) => {
        calls.push(args.join(' '));
        if (fail?.docker && args.join(' ').includes(fail.docker))
          throw new Error(`docker refused ${fail.docker}`);
        if (args[0] === 'run' && args.includes('NR_MAINTENANCE=1')) return probe;
        return 'sha256:' + 'a'.repeat(64);
      },
      http: async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (fail?.http && url.includes(fail.http)) return { ok: false, status: 503, body: null };
        if (url.endsWith('/api/session'))
          return { ok: true, status: 200, body: { required: true }, cookie: 'uimori=abc' };
        if (init?.method === 'POST')
          return { ok: true, status: 200, body: { status: JSON.parse(init.body).status } };
        const remaining = work[Math.min(index++, work.length - 1)];
        return { ok: true, status: 200, body: { status: 'closed', activeWork: remaining } };
      },
      now: () => (time += 10),
      sleep: async () => {},
      accessToken: () => 'secret-token',
    },
  };
}

test('a full transition closes the gate, verifies a candidate and reopens once', async () => {
  const { config, cleanup } = fixture();
  try {
    const runner = io({ work: [2, 0] });
    const summary = await runUpdate({ config, requestKey: 'update-0001', io: runner.io });
    assert.equal(summary.status, 'completed');
    assert.deepEqual(
      summary.stages.map((stage) => `${stage.name}:${stage.status}`),
      [
        'prepare:done',
        'close:done',
        'drain:done',
        'stop:done',
        'backup:done',
        'candidate:done',
        'switch:done',
        'reopen:done',
      ]
    );
    const environment = readFileSync(config.envFile, 'utf8');
    // Only the two controller-owned keys change; the operator's own lines stay byte for byte.
    assert.match(environment, /NR_ACCESS_TOKEN=secret-token/u);
    assert.match(environment, /UIMORI_IMAGE=ghcr\.io\/team\/uimori:2026\.9\.14/u);
    assert.match(environment, /UIMORI_DATA_VOLUME=uimori_data-update-0001-/u);
    const gate = runner.calls.filter((call) =>
      call.includes('POST https://story.example.test/api/maintenance')
    );
    assert.equal(gate.length, 2);
    // The same key never runs a second transition.
    const repeat = await runUpdate({ config, requestKey: 'update-0001', io: io().io });
    assert.equal(repeat.status, 'completed');
    assert.equal(repeat.startedAt, summary.startedAt);
    // A live install is never reversed by a cancel after the switch.
    assert.throws(() => requestCancel(validateConfig(config), 'update-0001'), /already serves/u);
  } finally {
    cleanup();
  }
});

test('a candidate that fails its migration probe restores the previous image and reopens', async () => {
  const { config, cleanup } = fixture();
  try {
    const runner = io({ probe: 'Error: DATABASE_MIGRATION_FAILED' });
    const summary = await runUpdate({ config, requestKey: 'update-0002', io: runner.io });
    assert.equal(summary.status, 'failed');
    assert.equal(summary.failedStage, 'candidate');
    assert.equal(summary.rollback, 'DONE');
    assert.equal(readFileSync(config.envFile, 'utf8'), ENV);
    assert.equal(
      runner.calls.filter((call) =>
        call.includes('POST https://story.example.test/api/maintenance')
      ).length,
      2
    );
  } finally {
    cleanup();
  }
});

test('a cancel before the switch stops the transition and leaves the install untouched', async () => {
  const { config, cleanup } = fixture();
  try {
    const resolved = validateConfig(config);
    const runner = io({ work: [1, 1, 1] });
    const original = runner.io.http;
    let seen = 0;
    runner.io.http = async (url, init) => {
      if (url.endsWith('/api/maintenance') && !init?.method && ++seen === 1)
        requestCancel(resolved, 'update-0003');
      return original(url, init);
    };
    const summary = await runUpdate({ config, requestKey: 'update-0003', io: runner.io });
    assert.equal(summary.status, 'cancelled');
    assert.equal(summary.failedStage, 'drain');
    assert.equal(readFileSync(config.envFile, 'utf8'), ENV);
    assert.equal(readJournal(resolved).status, 'cancelled');
    // Repeating the cancel returns the same receipt instead of starting anything new.
    assert.equal(requestCancel(resolved, 'update-0003').status, 'cancelled');
    assert.throws(() => requestCancel(resolved, 'other-key'), /No update/u);
  } finally {
    cleanup();
  }
});

test('configuration and environment edits refuse unsafe input', () => {
  const { config, cleanup } = fixture();
  try {
    assert.throws(() => validateConfig({ ...config, image: 'uimori' }), /full reference/u);
    assert.throws(() => validateConfig({ ...config, dataVolume: '../escape' }), /plain Docker/u);
    assert.throws(() => validateConfig({ ...config, appOrigin: 'http://example.test' }), /origin/u);
    assert.throws(
      () =>
        validateConfig({
          ...config,
          releaseRoot: path.join(path.dirname(config.composeFile), 'inside'),
        }),
      /outside the project/u
    );
    assert.equal(
      updateEnvironment('A=1\nB=2\n', { B: '3', C: '4' }),
      'A=1\nB=3\n\nC=4\n'.replace('\n\n', '\n')
    );
  } finally {
    cleanup();
  }
});

test('a failed backup and an unhealthy switch both return the install to its previous state', async () => {
  const first = fixture();
  try {
    const runner = io({ fail: { docker: 'tar -cf' } });
    const summary = await runUpdate({
      config: first.config,
      requestKey: 'update-0004',
      io: runner.io,
    });
    assert.equal(summary.failedStage, 'backup');
    assert.equal(summary.rollback, 'DONE');
    assert.equal(readFileSync(first.config.envFile, 'utf8'), ENV);
  } finally {
    first.cleanup();
  }
  const second = fixture();
  try {
    const runner = io({ fail: { http: '/api/session?' } });
    // The health read after the switch uses the session route without a cookie.
    runner.io.http = async (url, init) => {
      if (url.endsWith('/api/session') && !init?.method)
        return { ok: false, status: 502, body: null };
      if (url.endsWith('/api/session'))
        return { ok: true, status: 200, body: { required: true }, cookie: 'uimori=abc' };
      if (init?.method === 'POST') return { ok: true, status: 200, body: { status: 'closed' } };
      return { ok: true, status: 200, body: { status: 'closed', activeWork: 0 } };
    };
    const summary = await runUpdate({
      config: second.config,
      requestKey: 'update-0005',
      io: runner.io,
    });
    assert.equal(summary.failedStage, 'switch');
    assert.equal(summary.rollback, 'DONE');
    assert.equal(readFileSync(second.config.envFile, 'utf8'), ENV);
  } finally {
    second.cleanup();
  }
});

test('a second request key cannot start while one transition is still running', async () => {
  const { config, cleanup } = fixture();
  try {
    const resolved = validateConfig(config);
    const runner = io({ work: [1] });
    runner.io.sleep = async () => {};
    // A drain that never settles leaves the journal running for the next caller to see.
    const summary = await runUpdate({ config, requestKey: 'update-0006', io: runner.io });
    assert.equal(summary.failedStage, 'drain');
    writeFileSync(
      path.join(resolved.releaseRoot, 'update-journal.json'),
      JSON.stringify({ ...summary, status: 'running' })
    );
    await assert.rejects(
      runUpdate({ config, requestKey: 'update-0007', io: io().io }),
      /Another update is still running/u
    );
  } finally {
    cleanup();
  }
});
