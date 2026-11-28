const ZOD_V4 =
  "Import 'zod/v4'. Only a module that hands schemas to a zod 3 library (such as @a2ui) imports 'zod/v3'.";
const CONTRACT_SCHEMAS =
  'Contract schemas belong in packages/contracts behind #contracts/operations, not in core/.';
const OPERATIONS_STAY_OUT =
  'Core modules stay free of contract operation schemas; import wire types and constants from #contracts.';
const CORE_FILESYSTEM =
  'Only core/local-tokenizers.ts may use filesystem/runtime Node builtins in core/.';
const BROWSER_BUILTINS = 'Browser code cannot import Node builtins.';

const subpaths = (name) => [name, `${name}/**`];
const appCodeGlobs = (...names) => names.flatMap((name) => [`**/${name}`, `**/${name}/**`]);

const providerInternals = [
  '**/core/provider-http',
  '**/core/provider-http.*',
  '**/core/vertex',
  '**/core/vertex.*',
];
const fastifyFamily = [...subpaths('fastify'), '@fastify/**'];
const nodeSdks = [
  ...subpaths('sharp'),
  ...subpaths('web-push'),
  ...subpaths('wasmoon'),
  ...subpaths('msgpackr'),
  ...subpaths('stream-json'),
];
const browserLibraries = [
  ...subpaths('react'),
  ...subpaths('react-dom'),
  ...subpaths('dompurify'),
  '@codemirror/**',
  '@lezer/**',
  ...subpaths('lucide-react'),
];

const nodeBuiltinModules = `
  _http_agent _http_client _http_common _http_incoming _http_outgoing _http_server _stream_duplex
  _stream_passthrough _stream_readable _stream_transform _stream_wrap _stream_writable _tls_common
  _tls_wrap assert assert/strict async_hooks buffer child_process cluster console constants crypto
  dgram diagnostics_channel dns dns/promises domain events fs fs/promises http http2 https
  inspector inspector/promises module net os path path/posix path/win32 perf_hooks process
  punycode querystring readline readline/promises repl stream stream/consumers stream/promises
  stream/web string_decoder sys timers timers/promises tls trace_events tty url util util/types v8
  vm wasi worker_threads zlib
`
  .trim()
  .split(/\s+/u);

const coreFilesystem = ['fs', 'fs/promises', 'module', 'zlib'];

const pattern = (group, message) => ({ group, message });

const productCode = {
  testsAndScripts: pattern(
    appCodeGlobs('tests', 'scripts'),
    'Product code cannot import tests or operational scripts.'
  ),
  packages: pattern(
    appCodeGlobs('packages'),
    'Import shared contracts through #contracts, not by a path into packages/.'
  ),
};

const contractsOutside = pattern(
  ['**', '!./**', '!../**', '!zod/v4'],
  'Contracts are runtime-neutral: import only modules inside packages/contracts and zod/v4.'
);
const contractsAppCode = pattern(
  [
    ...appCodeGlobs('core', 'server', 'web', 'tests', 'scripts', 'runner', 'third_party'),
    '**/package.json',
  ],
  'Contracts are the lowest layer and cannot import application code, including types.'
);

const serverPatterns = {
  ...productCode,
  web: pattern(
    appCodeGlobs('web'),
    'Server code cannot import the browser layer, including types.'
  ),
  runner: pattern(
    appCodeGlobs('runner'),
    'Server code cannot import runner scripts; spawn them by path.'
  ),
  providerInternals: pattern(
    providerInternals,
    'Provider execution must use core/transport instead of transport internals.'
  ),
  browserLibraries: pattern(
    [
      ...browserLibraries,
      ...subpaths('@a2ui/react'),
      ...subpaths('@a2ui/web_core'),
      ...subpaths('intl-messageformat'),
    ],
    'Server code cannot import browser UI libraries.'
  ),
  app: pattern(
    ['./app', './app.*', '**/app', '**/app.*'],
    'Only server/index.ts may import server/app; pass dependencies through route arguments instead.'
  ),
  thirdParty: pattern(
    appCodeGlobs('third_party'),
    'Only server/compat/risu/** and server/risu-native-cbs.ts may import vendored third_party modules.'
  ),
  risuCompat: pattern(
    ['./compat/risu', './compat/risu/**', '**/compat/risu', '**/compat/risu/**'],
    'Risu compatibility adapters stay behind server/risu-*.ts modules.'
  ),
};

const layers = [
  {
    name: 'browserSpecs',
    includes: ['tests/**/*browser.spec.ts'],
    paths: {
      '@playwright/test':
        'Import from ./fixtures/browser-test.js so the shared page checks run after the test.',
      zod: ZOD_V4,
    },
  },
  {
    name: 'runner',
    includes: ['runner/**'],
    patterns: {
      standalone: pattern(
        ['**', '!node:*', '!node:*/**', '!./**'],
        'Runner scripts run standalone in the container and may import only node:* builtins and modules inside runner/.'
      ),
    },
  },
  {
    name: 'contracts',
    includes: ['packages/**'],
    paths: { zod: ZOD_V4 },
    patterns: { outside: contractsOutside, appCode: contractsAppCode },
  },
  {
    name: 'contractDomains',
    extends: 'contracts',
    includes: ['packages/contracts/src/domains/*/**'],
    add: {
      patterns: {
        siblingDomains: pattern(
          ['../*/**', '!../../**', '../../domains/**'],
          'Contract domains cannot import sibling domains; move shared constants or schemas into packages/contracts/src/domains/.'
        ),
      },
    },
  },
  {
    name: 'contractEndpoints',
    extends: 'contractDomains',
    includes: ['packages/**/endpoints.ts'],
    add: {
      paths: {
        'zod/v4':
          'Endpoint files are imported through #contracts into the browser startup bundle and must not import zod/v4; put schemas in operations.ts.',
      },
    },
    change: {
      patterns: {
        outside: {
          group: ['**', '!./**', '!../**'],
          message:
            'Endpoint files are runtime-neutral and schema-free: import only modules inside packages/contracts.',
        },
      },
    },
  },
  {
    name: 'core',
    includes: ['core/**'],
    paths: {
      zod: ZOD_V4,
      'zod/v3':
        "Only core/story-ui-catalog.ts may import 'zod/v3' to extend @a2ui/web_core schemas.",
      'zod/v4': CONTRACT_SCHEMAS,
      '#contracts/operations': OPERATIONS_STAY_OUT,
      ...Object.fromEntries(coreFilesystem.map((name) => [`node:${name}`, CORE_FILESYSTEM])),
      'node:child_process': 'Core modules cannot spawn processes.',
      'node:sqlite': 'Database access belongs in server/, not core/.',
      'node:worker_threads': 'Worker threads belong in server/, not core/.',
      ...Object.fromEntries(coreFilesystem.map((name) => [name, CORE_FILESYSTEM])),
      child_process: 'Core modules cannot spawn processes.',
      worker_threads: 'Worker threads belong in server/, not core/.',
    },
    patterns: {
      testsAndScripts: productCode.testsAndScripts,
      packages: productCode.packages,
      appLayers: pattern(
        appCodeGlobs('server', 'web'),
        'Core cannot import application layers, including types.'
      ),
      runner: pattern(appCodeGlobs('runner'), 'Core cannot import runner scripts.'),
      packageJson: pattern(['**/package.json'], 'Core cannot import package.json.'),
      thirdParty: pattern(
        appCodeGlobs('third_party'),
        'Only core/story-ui-catalog.ts may import vendored assets from third_party/.'
      ),
      zodSubpaths: pattern(['zod/v4/**', 'zod/v3/**'], CONTRACT_SCHEMAS),
      serverOnlyPackages: pattern(
        [
          ...fastifyFamily,
          ...nodeSdks,
          ...browserLibraries,
          ...subpaths('intl-messageformat'),
          ...subpaths('@a2ui/agent'),
          ...subpaths('@a2ui/react'),
        ],
        'Core cannot import server-only or browser UI packages.'
      ),
      tokenizers: pattern(
        [...subpaths('tiktoken'), '@huggingface/**'],
        'Only core/local-tokenizers.ts may import local tokenizer packages.'
      ),
    },
  },
  {
    name: 'coreStoryUiCatalog',
    extends: 'core',
    includes: ['core/story-ui-catalog.ts'],
    lift: { paths: ['zod/v3'], patterns: ['thirdParty'] },
    change: { patterns: { zodSubpaths: { group: ['zod/v4/**'] } } },
  },
  {
    name: 'coreLocalTokenizers',
    extends: 'core',
    includes: ['core/local-tokenizers.ts'],
    lift: {
      paths: [...coreFilesystem.map((name) => `node:${name}`), ...coreFilesystem],
      patterns: ['tokenizers'],
    },
  },
  {
    name: 'server',
    includes: ['server/**'],
    paths: { zod: ZOD_V4 },
    patterns: serverPatterns,
  },
  {
    name: 'serverIndex',
    extends: 'server',
    includes: ['server/index.ts'],
    lift: { patterns: ['app'] },
  },
  {
    name: 'serverRisuModules',
    extends: 'server',
    includes: ['server/risu-*.ts'],
    lift: { patterns: ['risuCompat'] },
  },
  {
    name: 'serverRisuCompat',
    extends: 'server',
    includes: ['server/compat/risu/**', 'server/risu-native-cbs.ts'],
    lift: { patterns: ['thirdParty', 'risuCompat'] },
  },
  {
    name: 'serverCommands',
    extends: 'server',
    includes: ['server/commands/**'],
    lift: { patterns: ['app'] },
    add: {
      paths: {
        'node:sqlite': 'Domain commands use TxPort and narrow ports instead of node:sqlite.',
        fastify: 'Domain commands are transport-neutral and cannot import fastify.',
      },
      patterns: {
        fastifySubpaths: pattern(
          ['fastify/**', '@fastify/**'],
          'Domain commands are transport-neutral and cannot import fastify.'
        ),
        store: pattern(
          ['**/store', '**/store.*', '**/product-store', '**/product-store.*'],
          'Domain commands receive Pick<AppPorts, ...> instead of importing Store or ProductStore.'
        ),
        requestValidation: pattern(
          ['**/request-validation', '**/request-validation.*'],
          'Domain commands validate through SplitOperation schemas and throw AppError instead of importing request-validation.'
        ),
        commandsApp: pattern(
          ['./app', './app.*', '**/app', '**/app.*'],
          'Domain commands cannot import server/app.'
        ),
      },
    },
  },
  {
    name: 'web',
    includes: ['web/**'],
    paths: {
      zod: ZOD_V4,
      '#contracts/operations':
        'Web code imports endpoints and types from #contracts; #contracts/operations holds the zod schemas the startup bundle must not load.',
      ...Object.fromEntries(nodeBuiltinModules.map((name) => [name, BROWSER_BUILTINS])),
    },
    patterns: {
      testsAndScripts: productCode.testsAndScripts,
      packages: productCode.packages,
      server: pattern(
        appCodeGlobs('server'),
        'Browser contracts belong in packages/contracts or core; do not import server code or types.'
      ),
      thirdParty: pattern(
        appCodeGlobs('third_party'),
        'Browser code cannot import vendored third_party modules directly.'
      ),
      runner: pattern(appCodeGlobs('runner'), 'Browser code cannot import runner scripts.'),
      packageJson: pattern(['**/package.json'], 'Browser code cannot import package.json.'),
      zod: pattern(
        ['zod/**'],
        'Browser code must not import zod directly; shared schemas live in packages/contracts behind #contracts/operations.'
      ),
      nodeOnlyCore: pattern(
        [
          ...providerInternals,
          '**/core/local-tokenizers',
          '**/core/local-tokenizers.*',
          '**/core/provider-fetch',
          '**/core/provider-fetch.*',
          '**/core/vertex-auth',
          '**/core/vertex-auth.*',
          '**/core/transport',
          '**/core/transport.*',
          '**/core/*-protocol',
          '**/core/*-protocol.*',
          '**/core/provider',
          '**/core/provider.*',
        ],
        'Browser code cannot import Node-only or provider-transport core modules.'
      ),
      nodeBuiltinsAndSdks: pattern(
        [
          'node:*',
          'node:*/**',
          ...subpaths('undici'),
          ...subpaths('google-auth-library'),
          ...fastifyFamily,
          ...nodeSdks,
          ...subpaths('tiktoken'),
          '@huggingface/**',
          ...subpaths('@a2ui/agent'),
        ],
        'Browser code cannot import Node builtins or server SDKs.'
      ),
    },
  },
];

function resolveLayer(layer, resolved) {
  const fail = (problem) => {
    throw new Error(`biome-config: layer "${layer.name}" ${problem}`);
  };
  const parent = layer.extends ? resolved.get(layer.extends) : { paths: {}, patterns: {} };
  if (!parent) fail(`extends "${layer.extends}", which is not defined before it`);
  const paths = { ...parent.paths };
  const patterns = { ...parent.patterns };
  const existing = (kind, table, name) => {
    if (!Object.hasOwn(table, name))
      fail(`names ${kind} "${name}", which "${layer.extends}" lacks`);
  };
  const absent = (kind, table, name) => {
    if (Object.hasOwn(table, name)) fail(`adds ${kind} "${name}", which "${layer.extends}" has`);
  };
  for (const name of layer.lift?.paths ?? []) {
    existing('path', paths, name);
    delete paths[name];
  }
  for (const name of layer.lift?.patterns ?? []) {
    existing('pattern', patterns, name);
    delete patterns[name];
  }
  for (const [name, change] of Object.entries(layer.change?.patterns ?? {})) {
    existing('pattern', patterns, name);
    patterns[name] = { ...patterns[name], ...change };
  }
  const own = layer.extends ? layer.add : layer;
  for (const [name, message] of Object.entries(own?.paths ?? {})) {
    absent('path', paths, name);
    paths[name] = message;
  }
  for (const [name, added] of Object.entries(own?.patterns ?? {})) {
    absent('pattern', patterns, name);
    patterns[name] = added;
  }
  return { paths, patterns };
}

function importRule({ paths, patterns }) {
  const options = {};
  if (Object.keys(paths).length) options.paths = paths;
  if (Object.keys(patterns).length)
    options.patterns = Object.values(patterns).map(({ group, message }) => ({ group, message }));
  return { level: 'error', options };
}

const scriptsOverride = {
  includes: ['scripts/**'],
  linter: { rules: { correctness: { noUndeclaredVariables: 'error' } } },
};

export function buildBiomeConfig({ schemaVersion }) {
  const resolved = new Map();
  const overrides = layers.map((layer) => {
    const result = resolveLayer(layer, resolved);
    resolved.set(layer.name, result);
    return {
      includes: layer.includes,
      linter: { rules: { style: { noRestrictedImports: importRule(result) } } },
    };
  });
  overrides.splice(1, 0, scriptsOverride);
  return {
    $schema: `https://biomejs.dev/schemas/${schemaVersion}/schema.json`,
    vcs: { enabled: true, clientKind: 'git', useIgnoreFile: true },
    files: {
      ignoreUnknown: true,
      includes: [
        'core/**',
        'packages/**',
        'runner/**',
        'server/**',
        'web/**',
        'tests/**',
        'scripts/**',
        'fixtures/**',
        '.vscode/**',
        '*.json',
        '*.mjs',
        '*.ts',
        '!package-lock.json',
      ],
    },
    formatter: { indentStyle: 'space', indentWidth: 2, lineWidth: 100, lineEnding: 'lf' },
    javascript: {
      formatter: { quoteStyle: 'single', trailingCommas: 'es5', semicolons: 'always' },
    },
    assist: { enabled: false },
    linter: {
      enabled: true,
      rules: {
        preset: 'recommended',
        style: {
          preset: 'none',
          noRestrictedImports: importRule({ paths: { zod: ZOD_V4 }, patterns: {} }),
        },
        complexity: { preset: 'none' },
        a11y: { preset: 'none' },
        correctness: {
          useExhaustiveDependencies: {
            level: 'on',
            options: {
              hooks: [
                {
                  name: 'useRetryableEffect',
                  closureIndex: 0,
                  dependenciesIndex: 1,
                  stableResult: true,
                },
              ],
            },
          },
        },
        suspicious: {
          noExplicitAny: 'off',
          noAssignInExpressions: 'off',
          noThenProperty: 'off',
          noArrayIndexKey: 'off',
        },
      },
    },
    overrides,
  };
}
