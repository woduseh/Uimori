import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rule = 'lint/style/noRestrictedImports';

const productForbidden = ['../tests/x', '../scripts/x', '../packages/x', '../runner/x'];

const coreEverywhere = [
  ...['zod', 'zod/v4', 'zod/v4/core', '#contracts/operations', 'react', 'fastify', 'sharp'],
  ...[
    'node:child_process',
    'child_process',
    'node:sqlite',
    'node:worker_threads',
    'worker_threads',
  ],
  ...['../server/x', '../web/x', '../package.json', ...productForbidden],
];
const coreFilesystem = [
  ...['node:fs', 'fs', 'node:fs/promises', 'fs/promises', 'node:module', 'module'],
  ...['node:zlib', 'zlib'],
];
const coreTokenizers = ['tiktoken', '@huggingface/transformers'];

const serverEverywhere = [
  ...['zod', '../web/x', '../tests/x', '../scripts/x', '../packages/x', '../runner/x'],
  ...['../core/provider-http', '../core/vertex', 'react', 'lucide-react', '@a2ui/web_core'],
];
const serverApp = ['./app', '../app'];
const serverVendored = ['../third_party/x'];
const serverRisu = ['./compat/risu/x'];

const cases = [
  [
    'tests/probe.browser.spec.ts',
    ['@playwright/test', 'zod'],
    ['zod/v4', './fixtures/browser-test.js', '../server/x'],
  ],
  ['tests/probe.ts', ['zod'], ['@playwright/test', '../server/x']],
  ['scripts/probe.ts', ['zod'], ['zod/v4', 'node:fs', '../server/x']],
  [
    'runner/probe.ts',
    ['left-pad', 'zod/v4', '../core/x', '../server/x'],
    ['node:fs', 'node:path', './helper.mjs'],
  ],
  [
    'packages/contracts/src/probe.ts',
    ['zod', 'left-pad', 'node:fs', '../../core/x', '../server/x', '../web/x', '../package.json'],
    ['zod/v4', './x', '../x'],
  ],
  [
    'packages/contracts/src/domains/chat/probe.ts',
    ['zod', 'left-pad', '../billing/x', '../../domains/x', '../../../core/x'],
    ['zod/v4', './x', '../limits', '../../x'],
  ],
  [
    'packages/contracts/src/domains/chat/operations.ts',
    ['zod', '../billing/x', '../../../server/x'],
    ['zod/v4'],
  ],
  [
    'packages/contracts/src/domains/chat/endpoints.ts',
    ['zod', 'zod/v4', 'left-pad', 'node:fs', '../billing/x', '../../../server/x'],
    ['./x', '../x'],
  ],
  [
    'core/probe.ts',
    [...coreEverywhere, ...coreFilesystem, 'zod/v3', '../third_party/x', ...coreTokenizers],
    ['node:path', 'node:crypto', '#contracts', './x', '../x'],
  ],
  [
    'core/story-ui-catalog.ts',
    [...coreEverywhere, ...coreFilesystem, ...coreTokenizers],
    ['zod/v3', '../third_party/x'],
  ],
  [
    'core/local-tokenizers.ts',
    [...coreEverywhere, 'zod/v3', '../third_party/x'],
    [...coreFilesystem, ...coreTokenizers],
  ],
  [
    'server/probe.ts',
    [...serverEverywhere, ...serverApp, ...serverVendored, ...serverRisu],
    ['zod/v4', 'fastify', 'node:sqlite', 'node:fs', '#contracts', '../core/transport', './store'],
  ],
  [
    'server/index.ts',
    [...serverEverywhere, ...serverVendored, ...serverRisu],
    ['./app', './app.js', 'fastify'],
  ],
  ['server/risu-probe.ts', [...serverEverywhere, ...serverApp, ...serverVendored], serverRisu],
  ['server/sub/risu-probe.ts', [...serverRisu, ...serverApp], []],
  [
    'server/risu-native-cbs.ts',
    [...serverEverywhere, ...serverApp],
    [...serverVendored, ...serverRisu],
  ],
  [
    'server/compat/risu/probe.ts',
    [...serverEverywhere, ...serverApp],
    [...serverVendored, ...serverRisu],
  ],
  [
    'server/commands/probe.ts',
    [
      ...[...serverEverywhere, ...serverApp, ...serverVendored, ...serverRisu],
      ...['node:sqlite', 'fastify', 'fastify/plugin', '@fastify/cors'],
      ...['../store', '../product-store', '../request-validation'],
    ],
    ['zod/v4', '#contracts', './x', '../tx', 'node:fs'],
  ],
  [
    'web/probe.ts',
    [
      ...['zod', 'zod/v4', '#contracts/operations', 'node:fs', 'fs', 'path', 'undici', 'sharp'],
      ...['@a2ui/agent', 'tiktoken', '../server/x', '../package.json', '../third_party/x'],
      ...productForbidden,
      ...['../core/transport', '../core/provider-http', '../core/local-tokenizers'],
      ...['../core/vertex-auth', '../core/anthropic-protocol', '../core/provider'],
      ...builtinModules,
      ...['_stream_duplex', '_stream_passthrough', '_stream_readable', '_stream_transform'],
      ...['_stream_wrap', '_stream_writable'],
    ],
    ['#contracts', 'react', '@codemirror/view', '../core/x', './x'],
  ],
];

function lint() {
  const scratch = mkdtempSync(join(tmpdir(), 'uimori-biome-boundaries-'));
  try {
    const config = JSON.parse(readFileSync(join(root, 'biome.json'), 'utf8'));
    delete config.vcs;
    writeFileSync(join(scratch, 'biome.json'), JSON.stringify(config));
    for (const [file, forbidden, allowed] of cases) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      const specifiers = [...forbidden, ...allowed];
      writeFileSync(
        join(scratch, file),
        `${specifiers.map((specifier) => `import ${JSON.stringify(specifier)};`).join('\n')}\n`
      );
    }
    const run = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/@biomejs/biome/bin/biome'),
        'lint',
        '--reporter=json',
        '--max-diagnostics=none',
        '.',
      ],
      { cwd: scratch, encoding: 'utf8', maxBuffer: 1 << 26 }
    );
    const report = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
    const flagged = new Set();
    for (const diagnostic of report.diagnostics)
      if (diagnostic.category === rule)
        flagged.add(
          `${diagnostic.location.path.replaceAll('\\', '/')}:${diagnostic.location.start.line}`
        );
    const stray = report.diagnostics.filter((diagnostic) => diagnostic.category !== rule);
    return { flagged, stray };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('each layer and file exception of biome.json keeps its import boundary', () => {
  const { flagged, stray } = lint();
  assert.deepEqual(stray, []);
  const wrong = [];
  for (const [file, forbidden, allowed] of cases)
    [...forbidden, ...allowed].forEach((specifier, index) => {
      const refused = flagged.has(`${file}:${index + 1}`);
      if (refused !== index < forbidden.length)
        wrong.push(`${file} ${refused ? 'refuses' : 'allows'} '${specifier}'`);
    });
  assert.deepEqual(wrong, []);
});
