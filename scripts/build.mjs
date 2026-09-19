import { build } from './build-runner.mjs';

if (process.argv.length > 2) {
  console.error('npm run build accepts no arguments');
  process.exitCode = 2;
} else {
  const result = await build();
  console.log(
    JSON.stringify({
      status: result.status,
      buildId: result.identity?.buildId,
      elapsedMs: result.elapsedMs,
      failures: result.failures,
      evidence: result.evidence,
    })
  );
  if (result.status !== 'PASS') process.exitCode = 1;
}
