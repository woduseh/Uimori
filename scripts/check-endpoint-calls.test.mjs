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

function withRepository(files, allowlist, check) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-endpoint-calls-'));
  try {
    const allFiles = {
      ...(allowlist ? { [allowlistPath]: `${JSON.stringify(allowlist, null, 2)}\n` } : {}),
      ...files,
    };
    for (const [path, content] of Object.entries(allFiles)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), content);
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
        "export const label = api('Text') + api('Card');",
      ].join('\n'),
      'web/shadowed.ts': [
        "import { api } from './api.js';",
        "export const ok = () => { const api = (x: string) => x; return api('local'); };",
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
