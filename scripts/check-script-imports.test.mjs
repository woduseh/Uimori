import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { distRemedy, remedy, scriptImportErrors } from './check-script-imports.mjs';

function withRepository(files, check) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-script-imports-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), content);
    }
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('JavaScript outside the app that imports app code fails with the file, line and remedy', () => {
  withRepository(
    {
      'scripts/static.mjs': "import { Store } from '../dist/server/store.js';\nnew Store();\n",
      'scripts/dynamic.mjs': "const { run } = await import(\n  '../server/run.ts'\n);\n",
      'scripts/reexport.mjs': "export { encode } from '../core/protocol.js';\n",
      'scripts/package.mjs': "import { CLOSED } from '#contracts';\n",
      'tests/fixtures/deep.mjs': "import { app } from '../../web/app.js';\n",
      'measure.mjs': "import '../uimori/server/outside.js';\nimport './packages/inside.js';\n",
      'scripts/legacy.cjs': "const { Store } = require('../dist/server/store.js');\n",
      'scripts/created.mjs': [
        "import { createRequire } from 'node:module';",
        'const require = createRequire(import.meta.url);',
        "require('../core/a.js');",
        "createRequire(import.meta.url)('../server/b.js');",
      ].join('\n'),
    },
    (directory) => {
      assert.deepEqual(scriptImportErrors(directory, {}), [
        `measure.mjs:2: imports ./packages/inside.js; ${remedy}`,
        `scripts/created.mjs:3: imports ../core/a.js; ${remedy}`,
        `scripts/created.mjs:4: imports ../server/b.js; ${remedy}`,
        `scripts/dynamic.mjs:1: imports ../server/run.ts; ${remedy}`,
        `scripts/legacy.cjs:1: imports ../dist/server/store.js; ${remedy}`,
        `scripts/package.mjs:1: imports #contracts; ${remedy}`,
        `scripts/reexport.mjs:1: imports ../core/protocol.js; ${remedy}`,
        `scripts/static.mjs:1: imports ../dist/server/store.js; ${remedy}`,
        `tests/fixtures/deep.mjs:1: imports ../../web/app.js; ${remedy}`,
      ]);
    }
  );
});

test('TypeScript callers, app code itself, other scripts and import text in strings pass', () => {
  withRepository(
    {
      'scripts/typed.ts':
        "import { Store } from '#dist/server/store.js';\nimport { x } from '../core/x.ts';\n",
      'server/worker.mjs': "import { helper } from '../core/helper.js';\n",
      'web/public/sw.js': "self.addEventListener('fetch', () => {});\n",
      'scripts/lib.mjs':
        "import { other } from './other.mjs';\nimport assert from 'node:assert';\n",
      'scripts/fixture.test.mjs':
        "const source = \"import '../dist/server/app.js';\";\nconst icon = new URL('../web/public/icon.svg', import.meta.url);\n",
      'scripts/runtime.mjs':
        "const runtime = '../dist';\nawait import(runtime + '/server/store.js');\n",
    },
    (directory) => assert.deepEqual(scriptImportErrors(directory, {}), [])
  );
});

test('TypeScript outside the app that imports the build by a relative path fails, since tsc would read the built JavaScript', () => {
  withRepository(
    {
      'scripts/bench.ts': "import { Store } from '../dist/server/store.js';\n",
      'tests/fixtures/run.ts': "const { createApp } = await import('../../dist/server/app.js');\n",
      'vite.config.ts': "export default { build: { outDir: '../dist/web' } };\n",
    },
    (directory) =>
      assert.deepEqual(scriptImportErrors(directory, {}), [
        `scripts/bench.ts:1: imports ../dist/server/store.js; ${distRemedy}`,
        `tests/fixtures/run.ts:1: imports ../../dist/server/app.js; ${distRemedy}`,
      ])
  );
});

test('a named exception passes, and one that no longer imports app code must be removed', () => {
  withRepository(
    {
      'scripts/release-probe.test.mjs':
        "const { createApp } = await import('../dist/server/app.js');\n",
      'scripts/plain.test.mjs': "import assert from 'node:assert';\n",
    },
    (directory) =>
      assert.deepEqual(
        scriptImportErrors(directory, {
          'scripts/release-probe.test.mjs': 'release tooling',
          'scripts/plain.test.mjs': 'release tooling',
          'scripts/deleted.mjs': 'release tooling',
        }),
        [
          'scripts/plain.test.mjs: listed as an exception but imports no app code; remove it from scripts/check-script-imports.mjs',
          'scripts/deleted.mjs: listed as an exception but imports no app code; remove it from scripts/check-script-imports.mjs',
        ]
      )
  );
});
