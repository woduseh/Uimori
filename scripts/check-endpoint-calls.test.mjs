import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { endpointCallErrors } from './check-endpoint-calls.mjs';

const endpoints = [
  'export const demoEndpoints = {',
  '  readOptions: defineEndpoint<typeof operations.readOptions>()({',
  "    operation: 'demo.readOptions',",
  "    method: 'GET',",
  "    path: '/chats/:chatId/options',",
  '  }),',
  '  fixOptions: defineEndpoint<typeof operations.fixOptions>()({',
  "    operation: 'demo.fixOptions',",
  "    method: 'POST',",
  "    path: '/chats/:chatId/options/fixed',",
  '  }),',
  '  readProfile: defineEndpoint<typeof operations.readProfile>()({',
  "    operation: 'demo.readProfile',",
  "    method: 'GET',",
  "    path: '/templates/:id',",
  '  }),',
  '};',
].join('\n');

const code = (text) => text.replaceAll('#{', '$' + '{');

function withRepository(files, check) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-endpoint-calls-'));
  try {
    for (const [path, content] of Object.entries({
      'packages/contracts/src/domains/demo/endpoints.ts': endpoints,
      ...files,
    })) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), code(content));
    }
    check(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('an api call whose path and method name a contract route fails with the operation to call', () => {
  withRepository(
    {
      'web/literal.ts': "await api('/chats/abc/options');\n",
      'web/template.tsx':
        'await api<State>(`/chats/#{encodeURIComponent(id)}/options/fixed`, body);\n',
      'web/variable.ts': [
        'const chat = `/chats/#{id}`;',
        'await api(`#{chat}/options`);',
        'await apiBinary(`#{chat}/options/fixed`, blob);',
      ].join('\n'),
      'web/explicit.ts': "await api(`/chats/#{id}/options/fixed`, body, 'POST');\n",
    },
    (directory) => {
      const errors = endpointCallErrors(directory);
      assert.equal(errors.length, 5);
      assert.match(
        errors.find((error) => error.startsWith('web/literal.ts:1:')),
        /demo\.readOptions/u
      );
      assert.match(
        errors.find((error) => error.startsWith('web/template.tsx:1:')),
        /demo\.fixOptions/u
      );
      assert.ok(errors.some((error) => error.startsWith('web/variable.ts:2:')));
      assert.ok(errors.some((error) => error.startsWith('web/variable.ts:3:')));
      assert.ok(errors.some((error) => error.startsWith('web/explicit.ts:1:')));
      assert.match(errors[0], /callEndpoint/u);
    }
  );
});

test('another method, an unrelated path and a path the check cannot see through pass', () => {
  withRepository(
    {
      'web/method.ts': "await api('/chats/abc/options', { a: 1 }, 'DELETE');\n",
      'web/other.ts': 'await api(`/chats/#{id}/profile`);\nawait api(`#{chat}/profile`);\n',
      'web/opaque.ts':
        'await api(path, body);\nawait api(`#{base}`);\nawait api(operation.path);\n',
      'web/endpoint.ts': 'await callEndpoint(endpoints.readOptions, { chatId });\n',
    },
    (directory) => assert.deepEqual(endpointCallErrors(directory), [])
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

test('contract paths built from a same-file const are read, and a path the check cannot read fails loudly', () => {
  withRepository(
    {
      'packages/contracts/src/domains/runtime/endpoints.ts': [
        "const base = '/runtime';",
        'export const runtimeEndpoints = {',
        endpointObject('runtime.read', 'base'),
        endpointObject('runtime.login', '`#{base}/login`'),
        '};',
      ].join('\n'),
      'web/runtime.ts': "await api('/runtime');\nawait api('/runtime/login');\n",
    },
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
        '  second: other({',
        "    operation: 'runtime.second',",
        '  }),',
        '};',
      ].join('\n'),
    },
    (directory) => {
      const errors = endpointCallErrors(directory);
      assert.equal(errors.length, 2);
      assert.match(errors[0], /runtime\.read has a method or path this check cannot resolve/u);
      assert.match(errors[1], /runtime\.second has a method or path this check cannot resolve/u);
    }
  );
  withRepository(
    {
      'packages/contracts/src/domains/runtime/endpoints.ts': [
        'export const runtimeEndpoints = {',
        '  read: build({',
        '    operation: runtimeOperation,',
        '  }),',
        '};',
      ].join('\n'),
    },
    (directory) => {
      const errors = endpointCallErrors(directory);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /1 operation: entries but 0 endpoint objects/u);
    }
  );
});
