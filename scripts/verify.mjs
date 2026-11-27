import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runBrowserVerification } from './browser-verification.mjs';
import { changedFiles } from './check-changed.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = [
  'Usage: npm run verify -- <name>... [--grep <pattern>] [--visual] [--workers <n>] [--shard <i/n>]',
  '       npm run verify -- --changed [<base>] [options]',
].join('\n');
const fullRegression = 'all';
const fallbackPreset = 'browser-smoke';
const engines = {
  gallery: {
    script: 'scripts/verify-gallery.mjs',
    title: 'Screen and journey captures; accepts no options',
  },
  copy: {
    script: 'scripts/check-ui-copy.mjs',
    title: 'Warning-only literal UI copy inventory; no browser',
  },
  'risu-native-samples': {
    script: 'scripts/verify-risu-native-samples.mjs',
    title: 'Private local CHARX acceptance; needs UIMORI_RISU_SAMPLE_ROOT',
  },
};
const runnerScripts = {
  'self-host': { script: 'scripts/verify-self-host.mjs', options: ['--grep'] },
};
const valueOptions = new Set(['--grep', '--workers', '--shard']);
const harnessOptions = new Set([...valueOptions, '--visual']);
const browserInput =
  /^(?:web|core|server|runner)\/|^tests\/(?:fixtures\/|[^/]+\.spec\.ts$)|^playwright\.config\.ts$/u;
const minimumTimeout = 900_000;
const perFileTimeout = 60_000;
const fullTimeout = 3_600_000;

export function readFeatureMap(directory = root) {
  return JSON.parse(readFileSync(path.join(directory, 'tests/feature-map.json'), 'utf8'));
}

export function parseArguments(argv) {
  if (argv[0] === '--changed') {
    const base = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
    return { changed: true, base, names: [], options: argv.slice(base ? 2 : 1) };
  }
  const firstOption = argv.findIndex((argument) => argument.startsWith('--'));
  const names = firstOption === -1 ? argv : argv.slice(0, firstOption);
  if (!names.length) throw new Error(usage);
  return { changed: false, names, options: firstOption === -1 ? [] : argv.slice(firstOption) };
}

export function verificationNames(map) {
  const names = new Map([[fullRegression, { kind: 'all', title: 'Complete browser regression' }]]);
  const add = (name, kind, title) => {
    if (names.has(name))
      throw new Error(
        `Verification name ${name} is taken twice (${names.get(name).kind}, ${kind})`
      );
    names.set(name, { kind, title });
  };
  for (const [name, domain] of Object.entries(map.domains)) add(name, 'domain', domain.title);
  for (const [name, preset] of Object.entries(map.presets ?? {})) add(name, 'preset', preset.title);
  for (const [name, engine] of Object.entries(engines)) add(name, 'engine', engine.title);
  return names;
}

function describeNames(names) {
  return [...names]
    .map(([name, { kind, title }]) => `  ${name.padEnd(22)} ${kind.padEnd(7)} ${title}`)
    .join('\n');
}

function launchOf(map, entry, env) {
  const launch = {
    runner: 'browser-harness',
    providerFixture: false,
    ...map.defaults?.launch,
    ...entry.launch,
  };
  return {
    runner: launch.runner,
    providerFixture: launch.providerFixture,
    privateMaterials:
      launch.privateMaterials === true ||
      Boolean(launch.privateMaterialsEnv && env[launch.privateMaterialsEnv]),
    missingEnv: (launch.requiredEnv ?? []).filter((name) => !env[name]),
    diagnostic:
      launch.diagnosticEnv && env[launch.diagnosticEnv] === '1' ? launch.diagnosticEnv : '',
  };
}

function launchRuns(map, entries, { name, scope, grep, env, skipped }) {
  const groups = new Map();
  for (const entry of entries) {
    const launch = launchOf(map, entry, env);
    if (launch.missingEnv.length) {
      skipped.push({ file: entry.file, missingEnv: launch.missingEnv });
      continue;
    }
    const key = JSON.stringify([
      launch.runner,
      launch.privateMaterials,
      launch.providerFixture,
      launch.diagnostic,
    ]);
    if (!groups.has(key)) groups.set(key, { launch, files: [] });
    groups.get(key).files.push(entry.file);
  }
  return [...groups.values()].map(({ launch, files }) =>
    launch.runner === 'browser-harness'
      ? {
          kind: 'harness',
          name: `${name}${launch.privateMaterials ? '-private' : ''}${launch.diagnostic ? '-diagnostic' : ''}`,
          scope,
          files,
          ...(grep ? { grep } : {}),
          ...(launch.diagnostic
            ? {
                limitations: [
                  `${launch.diagnostic}=1 lets these specs accept partial results, so this run diagnoses and is not an acceptance receipt.`,
                ],
              }
            : {}),
          providerFixture: launch.providerFixture,
          privateMaterials: launch.privateMaterials,
          timeout: Math.max(minimumTimeout, files.length * perFileTimeout),
        }
      : { kind: 'script', name: launch.runner, ...runnerScripts[launch.runner] }
  );
}

export function privateMaterialEnv(map) {
  const names = new Set();
  const entries = Object.values(map.domains).flatMap((domain) => domain.specs);
  for (const { launch = {} } of [map.defaults ?? {}, ...entries]) {
    if (launch.privateMaterialsEnv) names.add(launch.privateMaterialsEnv);
    if (launch.privateMaterials) for (const name of launch.requiredEnv ?? []) names.add(name);
  }
  return [...names];
}

export function runOptions(run, options) {
  if (!run.options) return { kept: options, dropped: [] };
  const kept = [];
  const dropped = [];
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    const value = options[index + 1];
    const width =
      valueOptions.has(option) && value !== undefined && !value.startsWith('--') ? 2 : 1;
    (harnessOptions.has(option) && !run.options.includes(option) ? dropped : kept).push(
      ...options.slice(index, index + width)
    );
    index += width - 1;
  }
  return { kept, dropped };
}

export function planVerification(map, requested, { env = process.env, label } = {}) {
  const names = verificationNames(map);
  const unknown = requested.filter((name) => !names.has(name));
  if (unknown.length)
    throw new Error(
      `Unknown verification name: ${unknown.join(', ')}\n${usage}\n\n${describeNames(names)}`
    );
  const selected = [...new Set(requested)];
  if (selected.includes(fullRegression) && selected.length > 1)
    throw new Error(`${fullRegression} already runs every spec; name it alone`);
  const specs = new Map(
    Object.values(map.domains).flatMap((domain) => domain.specs.map((entry) => [entry.file, entry]))
  );
  const domains = selected.filter((name) => names.get(name).kind === 'domain');
  const skipped = [];
  const runs = launchRuns(
    map,
    domains.flatMap((name) => map.domains[name].specs),
    {
      name: label ?? domains.join('-'),
      scope: domains.map((name) => map.domains[name].title).join('; '),
      env,
      skipped,
    }
  );
  for (const name of selected) {
    const { kind } = names.get(name);
    if (kind === 'all')
      runs.push({
        kind: 'harness',
        name: 'browser',
        scope: 'Complete local synthetic browser regression',
        files: [],
        providerFixture: launchOf(map, {}, env).providerFixture,
        privateMaterials: false,
        timeout: fullTimeout,
      });
    else if (kind === 'engine') runs.push({ kind: 'script', name, script: engines[name].script });
    else if (kind === 'preset') {
      const preset = map.presets[name];
      runs.push(
        ...launchRuns(
          map,
          preset.specs.map((file) => specs.get(file)),
          { name, scope: preset.title, grep: preset.grep, env, skipped }
        )
      );
    }
  }
  return { runs, skipped };
}

export function selectChanged(map, files) {
  const owners = new Set();
  const uncovered = [];
  for (const file of files) {
    const matched = Object.entries(map.domains).filter(
      ([, domain]) =>
        domain.sources.some((pattern) => path.posix.matchesGlob(file, pattern)) ||
        domain.specs.some((entry) => entry.file === file)
    );
    for (const [name] of matched) owners.add(name);
    if (!matched.length && browserInput.test(file)) uncovered.push(file);
  }
  return {
    domains: Object.keys(map.domains).filter((name) => owners.has(name)),
    uncovered,
  };
}

function runScript(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code === 0));
  });
}

async function execute(run, options) {
  if (run.kind === 'script') {
    const { kept, dropped } = runOptions(run, options);
    if (dropped.length) console.log(`${run.name} ignores ${dropped.join(' ')}`);
    return runScript(run.script, kept);
  }
  const { kind: _kind, ...configuration } = run;
  process.argv = [...process.argv.slice(0, 2), ...options];
  const { summary } = await runBrowserVerification(configuration);
  return summary.status === 'PASS';
}

async function main(argv) {
  const map = readFeatureMap();
  const { changed, base, names, options } = parseArguments(argv);
  let requested = names;
  if (changed) {
    const files = changedFiles(base);
    const selection = selectChanged(map, files);
    requested = selection.domains;
    if (selection.uncovered.length) {
      console.log(
        `No feature-map domain covers: ${selection.uncovered.join(', ')}. Adding ${fallbackPreset}; a shared file such as web/style.css may need npm run verify -- ${fullRegression}.`
      );
      requested.push(fallbackPreset);
    }
    if (!requested.length) {
      console.log(
        `None of the ${files.length} changed files is a browser input; nothing to verify in a browser. npm run check:changed covers the rest.`
      );
      return;
    }
    console.log(`Changed files select: ${requested.join(', ')}`);
  }
  const plan = planVerification(map, requested, changed ? { label: 'changed' } : {});
  for (const { file, missingEnv } of plan.skipped)
    console.log(`SKIP ${file}: set ${missingEnv.join(', ')} to include it`);
  if (!plan.runs.length) throw new Error('Nothing left to run after skipping specs');
  for (const run of plan.runs) {
    if (!(await execute(run, options))) {
      process.exitCode = 1;
      return;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
