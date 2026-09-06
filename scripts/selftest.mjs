import http from 'node:http';
import path from 'node:path';
import { mkdir, writeFile, readFile, utimes, rm } from 'node:fs/promises';
import { root, artifactRoot, newId, json, command, requireCommand, readReport, assertHealth } from './lib.mjs';

const expected = {
  assertion: /^Injected assertion detected in fresh Vitest report$/,
  zero: /zero discovered tests/,
  skip: /required tests not PASS/,
  missing: /report missing/,
  'stale-report': /stale report/,
  'stale-server': /Stale\/wrong server/,
  timeout: /Command timeout/,
  cleanup: /Command exit 1/,
  'browser-missing': /Browser executable missing|browserType.launch/,
  'unknown-case': /Unknown case/,
  'unknown-milestone': /Unknown\/unimplemented milestone/,
};

async function childCase(name, directory) {
  await mkdir(directory, { recursive: true });
  const errors = []; let server; const commands = [];
  const started = Date.now(); const reportFile = path.join(directory, 'vitest.json');
  async function run(args, timeout = 20000) {
    const result = await command(args, { timeout, log: path.join(directory, `child-${commands.length}.log`) });
    const { output, ...record } = result; commands.push(record); return result;
  }
  try {
    if (['assertion', 'zero', 'skip', 'stale-report'].includes(name)) {
      const fixture = path.join(directory, 'fault.test.mjs');
      await writeFile(fixture, `import { test, expect } from 'vitest';\n${name === 'skip' ? "test.skip('required fixture', () => {});" : `test('required fixture', () => { expect(1).toBe(${name === 'assertion' ? 2 : 1}); });`}\n`);
      // Existing Vitest runner/reporter executes a real isolated test file.
      const config = path.join(directory, 'vitest.fixture.mjs');
      await writeFile(config, `export default { test: { include: [${JSON.stringify(fixture.replaceAll('\\', '/'))}], fileParallelism: false } };\n`);
      const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=json', `--outputFile=${reportFile}`];
      if (name === 'zero') args.push('-t', 'no-such-test-name', '--passWithNoTests');
      const result = await run(args);
      if (name === 'assertion') {
        let observations;
        try { await readReport(reportFile, started, 'vitest'); } catch (error) { observations = error.observations; }
        const report = JSON.parse(await readFile(reportFile, 'utf8'));
        const assertions = (report.testResults || []).flatMap(suite => suite.assertionResults || []);
        if (result.code !== 1 || result.timedOut || observations?.failed !== 1 || assertions.length !== 1 || assertions[0].fullName !== 'required fixture' || assertions[0].status !== 'failed' || !assertions[0].failureMessages?.some(message => /AssertionError: expected 1 to be 2/.test(message))) throw new Error('Deliberate assertion fixture was not reached; startup/environment failure is not assertion evidence');
        throw new Error('Injected assertion detected in fresh Vitest report');
      }
      requireCommand(result);
      if (name === 'stale-report') { const old = new Date(started - 60000); await utimes(reportFile, old, old); }
      await readReport(reportFile, started, 'vitest', name === 'zero' ? /no-such-test-name/ : undefined);
    } else if (name === 'missing') {
      requireCommand(await run(['-e', 'process.exitCode=0']));
      await readReport(reportFile, started, 'vitest');
    } else if (name === 'stale-server') {
      server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ buildId: 'older-build', instanceId: 'other-worktree', dbPath: 'other.sqlite' })); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      await assertHealth(`http://127.0.0.1:${server.address().port}`, { buildId: 'current-build', instanceId: 'owned-instance', dbPath: 'owned.sqlite' });
    } else if (name === 'timeout') {
      requireCommand(await run(['-e', 'setInterval(() => {}, 1000)'], 200));
    } else if (name === 'cleanup') {
      requireCommand(await run(['-e', 'console.error("original assertion failure");process.exitCode=1']));
    } else if (name === 'browser-missing') {
      const result = await command(['scripts/doctor.mjs'], { env: { NR_BROWSER_PATH: path.join(directory, 'nonexistent-browser.exe') }, timeout: 20000, log: path.join(directory, 'doctor.log') });
      commands.push({ command: result.command, code: result.code });
      const match = result.output.match(/Browser executable missing|browserType.launch[^\n]*/);
      if (result.code !== 0 && match) throw new Error(match[0]);
      throw new Error('Missing browser was not reported BLOCKED');
    } else if (['unknown-case', 'unknown-milestone'].includes(name)) {
      const result = await run(['scripts/verify.mjs', name === 'unknown-case' ? '--case' : '--milestone', 'nonexistent']);
      if (result.code !== 0) throw new Error(result.output.trim());
    } else throw new Error(`Unknown selftest fixture: ${name}`);
  } catch (error) { errors.push(error.message); }
  finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (name === 'cleanup') {
      // A real filesystem cleanup failure, after the original failing command.
      try { await rm(path.join(directory, 'missing-cleanup-target'), { force: false }); } catch (error) { errors.push(`Cleanup: ${error.code}`); }
    }
  }
  const result = { name, status: errors.length ? 'FAIL' : 'PASS', errors, commands, elapsedMs: Date.now() - started };
  await json(path.join(directory, 'inner-result.json'), result);
  console.log(JSON.stringify(result));
  process.exitCode = errors.length ? 1 : 0;
}

async function selftest(directory) {
  await mkdir(directory, { recursive: true });
  const results = [];
  for (const [name, pattern] of Object.entries(expected)) {
    const childDir = path.join(directory, name);
    const result = await command(['scripts/selftest.mjs', '--child', name, '--output', childDir], { timeout: 30000, log: path.join(directory, `${name}.log`) });
    let inner;
    try { inner = JSON.parse(await readFile(path.join(childDir, 'inner-result.json'), 'utf8')); } catch { inner = { errors: ['inner result missing'] }; }
    const primary = inner.errors?.[0] || '';
    const detected = result.code !== 0 && !result.timedOut && inner.status === 'FAIL' && pattern.test(primary) && (name !== 'cleanup' || inner.errors.length === 2 && /^Cleanup: ENOENT/.test(inner.errors[1]));
    results.push({ name, status: detected ? 'PASS' : 'FAIL', meaning: 'Expected inner failure detected', childExitCode: result.code, childResult: path.relative(directory, path.join(childDir, 'inner-result.json')), primaryError: primary, cleanupErrors: inner.errors?.slice(1) || [] });
  }
  const report = { status: results.every(result => result.status === 'PASS') ? 'PASS' : 'FAIL', completedAt: new Date().toISOString(), scope: 'Verifier failure detection only; these are not product PASS tests.', results };
  await json(path.join(directory, 'selftest.json'), report); console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}
const args = process.argv.slice(2);
try {
  if (args[0] === '--child' && args[2] === '--output' && args.length === 4) await childCase(args[1], path.resolve(args[3]));
  else if (args.length === 0 || args[0] === '--output' && args.length === 2) await selftest(args.length ? path.resolve(args[1]) : path.join(artifactRoot, `selftest-${newId()}`));
  else throw new Error('Usage: node scripts/selftest.mjs [--output <directory>]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
