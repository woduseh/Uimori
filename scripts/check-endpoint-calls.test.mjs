import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  allowlistPath,
  endpointCallErrors,
  shrinkLegacyApiAllowlist,
} from './check-endpoint-calls.mjs';

const demoEndpoints = [
  'export const demoEndpoints = {',
  '  readJob: defineEndpoint<typeof operations.readJob>()({',
  "    operation: 'reader.readJob',",
  "    method: 'GET',",
  "    path: '/jobs/:jobId',",
  '  }),',
  '  fixOptions: defineEndpoint<typeof operations.fixOptions>()({',
  "    operation: 'demo.fixOptions',",
  "    method: 'POST',",
  "    path: '/chats/:chatId/options/fixed',",
  '  }),',
  '};',
].join('\n');

const code = (text) => text.replaceAll('#{', '$' + '{');

function withRepository(files, allowlist, check) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-endpoint-calls-'));
  try {
    const allFiles = {
      'packages/contracts/src/domains/demo/endpoints.ts': demoEndpoints,
      ...(allowlist ? { [allowlistPath]: `${JSON.stringify(allowlist, null, 2)}\n` } : {}),
      ...files,
    };
    for (const [path, content] of Object.entries(allFiles)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), code(content));
    }
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('imported api and apiBinary calls (direct, aliased, and namespace) are counted while local api functions are ignored', () => {
  withRepository(
    {
      'web/direct.ts': [
        "import { api, apiBinary, callEndpoint } from './api.js';",
        "await api('/chats');",
        "await apiBinary('/uploads', blob);",
        'await callEndpoint(ep, {});',
      ].join('\n'),
      'web/aliased.ts': [
        "import { api as sendLegacy, apiBinary as sendBytes } from './api.js';",
        "await sendLegacy('/a');",
        "await sendBytes('/uploads', blob);",
      ].join('\n'),
      'web/nested/ns.ts': [
        "import * as client from '../api.js';",
        "await client.api('/a');",
        "await client['apiBinary']('/uploads', blob);",
        'await client.callEndpoint(ep, {});',
      ].join('\n'),
      'web/local.tsx': [
        'const api = (name: string) => name;',
        "export const label = api('Text') + api('/jobs/example');",
      ].join('\n'),
      'web/shadowed.ts': [
        "import { api } from './api.js';",
        "export const ok = () => { const api = (x: string) => x; return api('/jobs/example'); };",
        'export const typed = ({ api: 1 } as { api: number }).api;',
        "export const real = () => api('/chats');",
      ].join('\n'),
    },
    {
      permanent: {},
      debt: {
        'web/direct.ts': 2,
        'web/aliased.ts': 2,
        'web/nested/ns.ts': 2,
        'web/shadowed.ts': 1,
      },
    },
    (directory) => assert.deepEqual(endpointCallErrors(directory), [])
  );
});

test('a debt file calling a typed contract route through api() fails even when its call count stays within budget', () => {
  withRepository(
    {
      'web/AppAbout.tsx': "import { api } from './api.js';\nawait api<AppBuild>('/health');\n",
    },
    { permanent: {}, debt: { 'web/AppAbout.tsx': 1 } },
    (directory) => assert.deepEqual(endpointCallErrors(directory), [])
  );
  withRepository(
    {
      'web/AppAbout.tsx':
        "import { api } from './api.js';\nawait api<AppBuild>('/jobs/example');\n",
      'web/aliased.ts': [
        "import { api as legacy } from './api.js';",
        'const chat = `/chats/#{id}`;',
        'await legacy(`#{chat}/options/fixed`, body);',
      ].join('\n'),
      'web/ns.ts': [
        "import * as client from './api.js';",
        "await client.api('/jobs/example');",
      ].join('\n'),
    },
    {
      permanent: {},
      debt: { 'web/AppAbout.tsx': 1, 'web/aliased.ts': 1, 'web/ns.ts': 1 },
    },
    (directory) => {
      const errors = endpointCallErrors(directory);
      assert.equal(errors.length, 3);
      assert.match(
        errors.find((line) => line.startsWith('web/AppAbout.tsx:2:')),
        /reader\.readJob/u
      );
      assert.match(
        errors.find((line) => line.startsWith('web/aliased.ts:3:')),
        /demo\.fixOptions/u
      );
      assert.match(
        errors.find((line) => line.startsWith('web/ns.ts:2:')),
        /reader\.readJob/u
      );
    }
  );
});

test('new api(), apiBinary(), and direct fetch() calls fail, while web/api.ts owns fetch()', () => {
  withRepository(
    {
      'web/api.ts': "export const api = (p: string) => fetch('/api' + p);\n",
      'web/new-api.ts': "import { api } from './api.js';\nawait api('/chats');\n",
      'web/new-fetch.ts': "await fetch('/api/chats');\nawait window.fetch('/api/other');\n",
      'web/reexport.ts': "export { api } from './api.js';\n",
      'web/alias-value.ts': "import { api } from './api.js';\nconst fn = api;\nfn('/chats');\n",
      'web/ns-alias.ts':
        "import * as client from './api.js';\nconst fn = client.api;\nconst { api: other } = client;\nfn('/a');\nother('/b');\n",
    },
    { permanent: {}, debt: {} },
    (directory) => {
      const errors = endpointCallErrors(directory);
      assert.ok(errors.some((line) => line.startsWith('web/new-api.ts: 1 api() call(s)')));
      assert.ok(
        errors.some((line) => line.startsWith('web/new-fetch.ts: 2 direct fetch() call(s)'))
      );
      assert.ok(errors.some((line) => line.startsWith('web/reexport.ts:1: do not re-export')));
      assert.ok(errors.some((line) => line.startsWith('web/alias-value.ts:2: do not alias, pass')));
      assert.ok(errors.some((line) => line.startsWith('web/ns-alias.ts:2: do not alias or pass')));
      assert.ok(errors.some((line) => line.startsWith('web/ns-alias.ts:3: do not alias, pass')));
      assert.ok(!errors.some((line) => line.startsWith('web/api.ts')));
    }
  );
});

test('direct fetch() cannot hide inside a debt budget, and permanent entries must match exact counts', () => {
  withRepository(
    {
      'web/mixed.ts': "import { api } from './api.js';\nawait api('/a');\nawait fetch('/api/b');\n",
      'web/stale-perm.ts': 'export const ok = true;\n',
      'web/pinned.ts':
        "import { api, apiBinary } from './api.js';\nawait apiBinary('/uploads', blob);\nawait api('/a');\n",
    },
    {
      permanent: {
        'web/stale-perm.ts': { count: 1, kind: 'fetch', reason: 'Removed download.' },
        'web/pinned.ts': { count: 1, kind: 'apiBinary', reason: 'Raw upload.' },
      },
      debt: {
        'web/mixed.ts': 2,
        'web/pinned.ts': 1,
      },
    },
    (directory) => {
      const errors = endpointCallErrors(directory);
      assert.ok(errors.some((line) => line.startsWith('web/mixed.ts: 1 direct fetch() call(s)')));
      assert.ok(errors.some((line) => line.includes('web/stale-perm.ts has 0 direct fetch()')));
      assert.ok(!errors.some((line) => line.includes('web/pinned.ts')));
    }
  );
});

test('shrink lowers or removes debt entries with LF formatting and never adds new debt', () => {
  withRepository(
    {
      'web/shrunk.ts': "import { api } from './api.js';\nawait api('/a');\n",
      'web/cleaned.ts': "import { callEndpoint } from './api.js';\nawait callEndpoint(ep, {});\n",
      'web/added.ts': "import { api } from './api.js';\nawait api('/new');\n",
      'web/pinned.ts':
        "import { api, apiBinary } from './api.js';\nawait apiBinary('/uploads', blob);\nawait api('/a');\n",
    },
    {
      permanent: {
        'web/pinned.ts': { count: 1, kind: 'apiBinary', reason: 'Raw upload.' },
      },
      debt: {
        'web/shrunk.ts': 3,
        'web/cleaned.ts': 2,
        'web/pinned.ts': 4,
      },
    },
    (directory) => {
      const before = endpointCallErrors(directory);
      assert.ok(before.some((line) => line.includes('web/shrunk.ts now owes 1')));
      assert.ok(before.some((line) => line.includes('web/cleaned.ts owes no api() calls')));
      assert.ok(before.some((line) => line.includes('web/pinned.ts now owes 1')));

      const next = shrinkLegacyApiAllowlist(directory);
      assert.deepEqual(next.debt, { 'web/pinned.ts': 1, 'web/shrunk.ts': 1 });
      const written = readFileSync(join(directory, allowlistPath), 'utf8');
      assert.ok(!written.includes('\r\n'));
      assert.ok(written.endsWith('\n'));

      const after = endpointCallErrors(directory);
      assert.equal(after.length, 1);
      assert.ok(after[0].startsWith('web/added.ts: 1 api() call(s)'));
    }
  );
});

const endpointObject = (operation, path) =>
  [
    '  entry: defineEndpoint()({',
    `    operation: '${operation}',`,
    "    method: 'GET',",
    `    path: ${path},`,
    '  }),',
  ].join('\n');

test('contract paths built from a same-file const are read, and an unreadable contract path fails loudly', () => {
  withRepository(
    {
      'packages/contracts/src/domains/runtime/endpoints.ts': [
        "const base = '/runtime';",
        'export const runtimeEndpoints = {',
        endpointObject('runtime.read', 'base'),
        endpointObject('runtime.login', '`#{base}/login`'),
        '};',
      ].join('\n'),
      'web/runtime.ts':
        "import { api } from './api.js';\nawait api('/runtime');\nawait api('/runtime/login');\n",
    },
    { permanent: {}, debt: { 'web/runtime.ts': 2 } },
    (directory) => {
      const errors = endpointCallErrors(directory);
      assert.equal(errors.length, 2);
      assert.match(errors[0], /runtime\.read/u);
      assert.match(errors[1], /runtime\.login/u);
    }
  );
  withRepository(
    {
      'packages/contracts/src/domains/runtime/endpoints.ts': [
        "const paths = { read: '/runtime' };",
        'export const runtimeEndpoints = {',
        endpointObject('runtime.read', 'paths.read'),
        '};',
      ].join('\n'),
    },
    { permanent: {}, debt: {} },
    (directory) => {
      const errors = endpointCallErrors(directory);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /runtime\.read has a method or path this check cannot resolve/u);
    }
  );
});
