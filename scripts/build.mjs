import { build } from './build-runner.mjs';

if (process.argv.length > 2) {
  console.error('npm run build accepts no arguments');
  process.exitCode = 2;
} else {
  const result = await build();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') process.exitCode = 1;
}
