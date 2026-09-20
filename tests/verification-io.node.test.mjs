import assert from 'node:assert/strict';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  assertHealth,
  command,
  killOwned,
  readBrowserReport,
  removeOwned,
  requireCommand,
  root,
} from '../scripts/lib.mjs';

test('browser evidence must be a fresh, readable report', async (t) => {
  const parent = path.join(root, 'output', 'tooling-tests');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'report-'));
  t.after(() => removeOwned(parent, directory));
  const file = path.join(directory, 'playwright.json');
  const since = Date.now();
  await assert.rejects(readBrowserReport(file, since), /report missing/);
  await writeFile(file, '{truncated');
  await assert.rejects(readBrowserReport(file, since), SyntaxError);
  await writeFile(
    file,
    JSON.stringify({
      suites: [
        {
          title: 'fixture.spec.ts',
          suites: [
            {
              title: 'nested suite',
              specs: [
                {
                  title: 'executed assertion',
                  tests: [
                    {
                      status: 'expected',
                      expectedStatus: 'passed',
                      results: [{ status: 'passed' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
  );
  const report = await readBrowserReport(file, since);
  assert.equal(report.passed, 1);
  assert.equal(report.tests[0].title, 'fixture.spec.ts nested suite executed assertion');
  const old = new Date(since - 60_000);
  await utimes(file, old, old);
  await assert.rejects(readBrowserReport(file, since), /stale report/);
});

test('health admission requires successful HTTP and all three owned-server identities', async (t) => {
  const expected = { buildId: 'build', instanceId: 'instance', dbPath: 'owned.sqlite' };
  let actual = expected;
  let status = 200;
  const server = http.createServer((request, response) => {
    assert.equal(request.url, '/api/health');
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(actual));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await assertHealth(url, expected), expected);
  for (const field of Object.keys(expected)) {
    actual = { ...expected, [field]: 'other-owner' };
    await assert.rejects(assertHealth(url, expected), new RegExp(`Stale/wrong server ${field}`));
  }
  actual = expected;
  status = 503;
  await assert.rejects(assertHealth(url, expected), /Health HTTP 503/);
});

test('command failures retain the executed child diagnostic and nonzero exit', async () => {
  const result = await command([
    '-e',
    'console.error("injected child failure");process.exitCode=7',
  ]);
  assert.equal(result.code, 7, result.output);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /injected child failure/);
  assert.throws(() => requireCommand(result), /Command exit 7/);
});

test('command timeout terminates its live child and cannot become PASS', async (t) => {
  const children = new Set();
  t.after(async () => {
    for (const child of children) await killOwned(child);
  });
  const result = await command(['-e', 'console.log("ready");setInterval(() => {}, 1000)'], {
    children,
    timeout: 1500,
  });
  assert.match(result.output, /ready/);
  assert.equal(result.timedOut, true);
  assert.equal(children.size, 0);
  assert.throws(() => requireCommand(result), /Command timeout/);
});
