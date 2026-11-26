import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { docsOnly } from './ci-changes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const biomeFile = /\.(?:ts|tsx|mts|js|mjs|cjs|json|jsonc|css)$/u;
const typeScriptInput = /(?:\.(?:ts|tsx|mts)|^package\.json|^tsconfig[^/]*\.json)$/u;
const moduleFile = /^(?:core|server|web|runner|scripts|tests)\/.+\.(?:ts|tsx|mts|js|mjs)$/u;

export function selectChecks(files, testSources) {
  const modules = files.filter((file) => moduleFile.test(file));
  const markers = files
    .filter((file) => !moduleFile.test(file))
    .flatMap((file) => {
      const extension = extname(file);
      return [basename(file), ...(extension ? [`'${extension}'`, `"${extension}"`] : [])];
    });
  const namedTests = Object.entries(testSources)
    .filter(
      ([test, source]) =>
        !modules.includes(test) && markers.some((marker) => source.includes(marker))
    )
    .map(([test]) => test)
    .sort();
  return {
    docsOnly: docsOnly(files),
    documentation: files.some((file) => file.endsWith('.md')),
    biome: files.filter((file) => biomeFile.test(file)),
    typeScript: files.some((file) => typeScriptInput.test(file)),
    vitest: [...modules, ...namedTests],
  };
}

function gitList(...args) {
  return execFileSync('git', [...args, '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function changedFiles(base) {
  const files = new Set([
    ...gitList('diff', '--no-renames', '--name-only', base ?? 'HEAD'),
    ...gitList('ls-files', '--others', '--exclude-standard'),
  ]);
  return [...files].filter((file) => existsSync(join(root, file))).sort();
}

function testSources() {
  return Object.fromEntries(
    readdirSync(join(root, 'tests'), { recursive: true })
      .map((file) => `tests/${String(file).replaceAll('\\', '/')}`)
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => [file, readFileSync(join(root, file), 'utf8')])
  );
}

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
  if (result.status === 0) return { label, ok: true, output };
  return { label, ok: false, output: output.split('\n').slice(-80).join('\n') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = changedFiles(process.argv[2]);
  if (!files.length) {
    console.log('check:changed: no changed files');
    process.exit(0);
  }
  const checks = selectChecks(files, testSources());
  const results = [];
  if (checks.documentation || checks.docsOnly)
    results.push(run('docs', process.execPath, ['scripts/check-documentation.mjs']));
  results.push(run('diff', 'git', ['diff', '--check', process.argv[2] ?? 'HEAD']));
  if (!checks.docsOnly) {
    if (checks.biome.length)
      results.push(
        run('biome', process.execPath, [
          'node_modules/@biomejs/biome/bin/biome',
          'check',
          '--no-errors-on-unmatched',
          '--error-on-warnings',
          ...checks.biome,
        ])
      );
    if (checks.typeScript)
      results.push(run('tsc', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']));
    results.push(run('comments', process.execPath, ['scripts/check-comments.mjs']));
    results.push(run('i18n', process.execPath, ['scripts/check-i18n.mjs']));
    if (checks.vitest.length) {
      const vitest = run('vitest', process.execPath, [
        'node_modules/vitest/vitest.mjs',
        'related',
        '--run',
        '--passWithNoTests',
        ...checks.vitest,
      ]);
      const testFiles = vitest.output.match(/Test Files\s+([^\n]+)/u)?.[1]?.trim();
      if (testFiles) vitest.label = `vitest (${testFiles})`;
      results.push(vitest);
    }
  }
  for (const failure of results.filter((result) => !result.ok))
    console.error(`--- ${failure.label} FAIL\n${failure.output}`);
  const summary = results.map((result) => `${result.label} ${result.ok ? 'ok' : 'FAIL'}`);
  console.log(`check:changed: ${files.length} files · ${summary.join(' · ')}`);
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}
