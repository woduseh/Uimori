import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { docsOnly } from './ci-changes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultLimit = 30;
const usage = 'Usage: node scripts/check-changed.mjs [<base>] [--limit <n>] [--all] [--list-json]';
const biomeFile = /\.(?:ts|tsx|mts|js|mjs|cjs|json|jsonc|css)$/u;
const typeScriptInput = /(?:\.(?:ts|tsx|mts)|^package\.json|^tsconfig[^/]*\.json)$/u;
const moduleFile = /^(?:core|server|web|runner|scripts|tests)\/.+\.(?:ts|tsx|mts|js|mjs)$/u;
const moduleExtension = /\.(?:[cm]?[jt]sx?)$/u;
const commentSource = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|css)$/u;
const vitestFile = /^tests\/.+\.test\.ts$/u;
const toolingTestFile = /^(?:scripts\/[^/]+\.test\.mjs|tests\/[^/]+\.node\.test\.mjs)$/u;
const fullSuiteInput =
  /^(?:package(?:-lock)?\.json|vitest\.config\.ts|tsconfig[^/]*\.json|biome\.json|scripts\/build[^/]*\.mjs)$/u;
const fullCommentScan = /^scripts\/(?:check-comments\.mjs|comment-allowlist\.json)$/u;
const i18nInput = /^(?:web\/|scripts\/check-i18n\.mjs$)/u;
const userGuide = /^docs\/[^/]+\.md$/u;
const guideTest = 'tests/app-guides.test.ts';
const distEntry = /^server\/(?:index|app)\.ts$/u;
export const distTests = ['tests/background-work.test.ts', 'tests/server.test.ts'];
const importSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/gu;

function unique(values) {
  return [...new Set(values)];
}

function withoutExtension(file) {
  return file.replace(moduleExtension, '');
}

function importsAny(test, source, stems) {
  return [...source.matchAll(importSpecifier)].some(([, specifier]) =>
    stems.has(withoutExtension(posix.join(posix.dirname(test), specifier)))
  );
}

const hookFile = /^(?:\.githooks|\.claude\/hooks)\//u;

function selectToolingTests(files, toolingTests, toolingSources = {}) {
  const selected = [];
  const stems = new Set();
  let unmatched = false;
  for (const file of files) {
    if (toolingTestFile.test(file)) {
      if (toolingTests.includes(file)) selected.push(file);
      continue;
    }
    if (!file.startsWith('scripts/') && !hookFile.test(file)) continue;
    stems.add(withoutExtension(file));
    if (file.startsWith('scripts/') && /^scripts\/[^/]+$/u.test(file)) {
      const paired = `${file.replace(/\.[^./]+$/u, '')}.test.mjs`;
      if (toolingTests.includes(paired)) selected.push(paired);
      else unmatched = true;
    } else if (file.startsWith('scripts/')) unmatched = true;
  }
  if (unmatched) return 'all';
  for (const test of toolingTests) {
    const source = toolingSources[test];
    if (source && importsAny(test, source, stems)) selected.push(test);
  }
  const chosen = unique(selected).sort();
  if (stems.size && !chosen.length) return 'all';
  return chosen;
}

export function toolingNeedsBuild(tooling, sources = {}) {
  if (tooling === 'all') return true;
  return tooling.some((file) => /\bdist\//u.test(sources[file] ?? ''));
}

export function vitestRelatedFiles(files, exists) {
  return files.filter((file) => exists(file));
}

export function selectChecks(
  files,
  testSources,
  { exists = () => true, toolingTests = [], toolingSources = {} } = {}
) {
  const modules = files.filter((file) => moduleFile.test(file));
  const markers = files
    .filter((file) => !moduleFile.test(file))
    .flatMap((file) => {
      const extension = extname(file);
      return [basename(file), ...(extension ? [`'${extension}'`, `"${extension}"`] : [])];
    });
  const tests = Object.keys(testSources).sort();
  const namedTests = tests.filter(
    (test) =>
      !modules.includes(test) && markers.some((marker) => testSources[test].includes(marker))
  );
  const guideTests =
    files.some((file) => userGuide.test(file)) && tests.includes(guideTest) ? [guideTest] : [];
  const moduleNames = new Set(modules.map((file) => basename(withoutExtension(file))));
  const directTests = unique([
    ...modules.filter((file) => vitestFile.test(file) && exists(file)),
    ...namedTests,
    ...guideTests,
    ...tests.filter((test) => moduleNames.has(basename(test, '.test.ts'))),
  ]).sort();
  const moduleStems = new Set(modules.map(withoutExtension));
  const firstHopTests = tests.filter(
    (test) => !directTests.includes(test) && importsAny(test, testSources[test], moduleStems)
  );
  return {
    docsOnly: docsOnly(files),
    documentation: files.some((file) => file.endsWith('.md')),
    biome: files.filter((file) => biomeFile.test(file) && exists(file)),
    typeScript: files.some((file) => typeScriptInput.test(file)),
    comments: files.some((file) => fullCommentScan.test(file))
      ? 'all'
      : files.filter((file) => commentSource.test(file)),
    i18n: files.some((file) => i18nInput.test(file)),
    vitest: unique([...modules, ...namedTests, ...guideTests]),
    directTests,
    firstHopTests,
    tooling: selectToolingTests(files, toolingTests, toolingSources),
    fullRequired: files.filter((file) => fullSuiteInput.test(file)),
    notes: files.some((file) => distEntry.test(file))
      ? [
          `server/index.ts or server/app.ts changed: ${distTests.join(' and ')} execute dist, so they check this change only after \`npm run build\`; then run \`npm test -- ${distTests.join(' ')}\``,
        ]
      : [],
  };
}

export function prioritizeTests(affected, { direct, firstHop }, limit) {
  const ordered = unique([...direct, ...firstHop, ...[...affected].sort()]);
  if (ordered.length <= limit) return { run: ordered, total: ordered.length };
  return {
    run: ordered.slice(0, limit),
    total: ordered.length,
    notice: `${ordered.length} affected test files; ran ${limit} prioritized (direct matches and 1-hop importers first). Run the full \`npm test\` before finishing, or rerun with --all`,
  };
}

export function parseArguments(argv, env) {
  let base;
  let limit;
  let all = false;
  let listJson = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--all') all = true;
    else if (argument === '--list-json') listJson = true;
    else if (argument === '--limit') {
      limit = Number(argv[++index]);
      if (!Number.isInteger(limit) || limit < 1)
        throw new Error(`--limit needs a positive integer\n${usage}`);
    } else if (argument.startsWith('-') || base !== undefined) throw new Error(usage);
    else base = argument;
  }
  if (all) limit = Infinity;
  return { base, limit: limit ?? (env.CI === 'true' ? Infinity : defaultLimit), listJson };
}

function gitList(directory, ...args) {
  return execFileSync('git', [...args, '-z'], { cwd: directory, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

export function changedFiles(base, directory = root) {
  return [
    ...new Set([
      ...gitList(directory, 'diff', '--no-renames', '--name-only', base ?? 'HEAD'),
      ...gitList(directory, 'ls-files', '--others', '--exclude-standard'),
    ]),
  ].sort();
}

function testSources() {
  return Object.fromEntries(
    readdirSync(join(root, 'tests'), { recursive: true })
      .map((file) => `tests/${String(file).replaceAll('\\', '/')}`)
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => [file, readFileSync(join(root, file), 'utf8')])
  );
}

function toolingTestFiles() {
  return ['scripts', 'tests']
    .flatMap((directory) =>
      readdirSync(join(root, directory)).map((name) => `${directory}/${name}`)
    )
    .filter((file) => toolingTestFile.test(file));
}

function collectChecks(base) {
  const files = changedFiles(base);
  const toolingTests = toolingTestFiles();
  const toolingSources = Object.fromEntries(
    toolingTests.map((file) => [file, readFileSync(join(root, file), 'utf8')])
  );
  const checks = selectChecks(files, testSources(), {
    exists: (file) => existsSync(join(root, file)),
    toolingTests,
    toolingSources,
  });
  return { files, checks, toolingSources };
}

export async function listSelection(base) {
  const { files, checks } = collectChecks(base);
  const tests =
    checks.docsOnly || !checks.vitest.length
      ? { affected: [] }
      : await affectedTests(checks.vitest);
  const { run: affected } = prioritizeTests(
    tests.affected,
    { direct: checks.directTests, firstHop: checks.firstHopTests },
    Infinity
  );
  return { base: base ?? 'HEAD', files, ...checks, affectedTests: checks.docsOnly ? [] : affected };
}

async function affectedTests(related) {
  const existing = vitestRelatedFiles(related, (file) => existsSync(join(root, file)));
  if (!existing.length) return { affected: [], all: [] };
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest({ root, related: existing, watch: false, run: true });
  try {
    const name = (spec) => relative(root, spec.moduleId).replaceAll('\\', '/');
    return {
      affected: unique((await vitest.getRelevantTestSpecifications()).map(name)),
      all: unique((await vitest.globTestSpecifications()).map(name)),
    };
  } finally {
    await vitest.close();
  }
}

function run(label, command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', (error) => resolve({ label, ok: false, output: error.message }));
    child.on('close', (status) => {
      output = output.trimEnd();
      if (status === 0) resolve({ label, ok: true, output });
      else resolve({ label, ok: false, output: output.split('\n').slice(-80).join('\n') });
    });
  });
}

async function runVitest(checks, listing, limit, notices) {
  let tests;
  try {
    tests = await listing;
  } catch (error) {
    return { label: 'vitest', ok: false, output: error.stack ?? String(error) };
  }
  const selection = prioritizeTests(
    tests.affected,
    { direct: checks.directTests, firstHop: checks.firstHopTests },
    limit
  );
  if (selection.notice) notices.push(selection.notice);
  if (!selection.run.length) return { label: 'vitest (no related tests)', ok: true, output: '' };
  const everything =
    selection.run.length === tests.all.length &&
    tests.all.every((test) => selection.run.includes(test));
  const result = await run('vitest', process.execPath, [
    'node_modules/vitest/vitest.mjs',
    'run',
    ...(everything ? [] : selection.run),
  ]);
  const testFiles = result.output.match(/Test Files\s+([^\n]+)/u)?.[1]?.trim();
  const count = selection.notice ? ` ${selection.run.length}/${selection.total}` : '';
  result.label = `vitest${count}${testFiles ? ` (${testFiles})` : ''}`;
  return result;
}

async function runTooling(tooling, sources = {}) {
  const full = tooling === 'all';
  if (toolingNeedsBuild(tooling, sources)) {
    const build = await run('tooling build', process.execPath, ['scripts/build.mjs']);
    if (!build.ok) return build;
  }
  const result = await run(full ? 'tooling full suite' : 'tooling', process.execPath, [
    'scripts/test-tooling.mjs',
    ...(full ? [] : ['--files', ...tooling]),
  ]);
  result.label += ` (${result.output.match(/^PASS /gmu)?.length ?? 0} passed)`;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const { base, limit, listJson } = options;
  if (listJson) {
    process.stdout.write(`${JSON.stringify(await listSelection(base), null, 2)}\n`);
    process.exit(0);
  }
  const { files, checks, toolingSources } = collectChecks(base);
  if (!files.length) {
    console.log('check:changed: no changed files');
    process.exit(0);
  }
  const node = process.execPath;
  const statics = [];
  if (checks.documentation || checks.docsOnly)
    statics.push(run('docs', node, ['scripts/check-documentation.mjs']));
  statics.push(run('diff', 'git', ['diff', '--check', base ?? 'HEAD']));
  let listing;
  if (!checks.docsOnly) {
    if (checks.biome.length)
      statics.push(
        run('biome', node, [
          'node_modules/@biomejs/biome/bin/biome',
          'check',
          '--no-errors-on-unmatched',
          '--error-on-warnings',
          ...checks.biome,
        ])
      );
    if (checks.typeScript)
      statics.push(run('tsc', node, ['node_modules/typescript/bin/tsc', '--noEmit']));
    if (checks.comments === 'all' || checks.comments.length)
      statics.push(
        run('comments', node, [
          'scripts/check-comments.mjs',
          ...(checks.comments === 'all' ? [] : checks.comments),
        ])
      );
    if (checks.i18n) statics.push(run('i18n', node, ['scripts/check-i18n.mjs']));
    if (checks.vitest.length) listing = affectedTests(checks.vitest);
  }
  const results = await Promise.all(statics);
  const notices = [];
  if (listing) results.push(await runVitest(checks, listing, limit, notices));
  if (!checks.docsOnly && checks.tooling.length)
    results.push(await runTooling(checks.tooling, toolingSources));
  if (checks.fullRequired.length)
    notices.push(
      `scope: full-required (${checks.fullRequired.join(', ')}); related selection cannot see what these change, so run \`npm run quality:full\` before finishing`
    );
  notices.push(...checks.notes);
  for (const failure of results.filter((result) => !result.ok))
    console.error(`--- ${failure.label} FAIL\n${failure.output}`);
  for (const notice of notices) console.warn(`check:changed: ${notice}`);
  const summary = results.map((result) => `${result.label} ${result.ok ? 'ok' : 'FAIL'}`);
  console.log(`check:changed: ${files.length} files · ${summary.join(' · ')}`);
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}
