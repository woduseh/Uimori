import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  allowlistPath,
  readAllowlist,
  errorTextReads,
  shrinkAllowlist,
  uiMessageErrors,
} from './check-ui-message.mjs';

function withRepository(files, check) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-ui-message-'));
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

test('every way of reading message off a value counts, while writing or declaring one does not', () => {
  const source = [
    'type Failure = { message: string };',
    'export function View({ failure }: { failure: Failure }) {',
    '  try {',
    '    run();',
    '  } catch (caught) {',
    '    show((caught as Error).message);',
    '    show(caught?.message);',
    "    show(caught['message']);",
    '    const { message } = caught as Error;',
    '    show(message);',
    '  }',
    '  const created = { message: failure, other: 1 };',
    '  return <Notice message={created.other} />;',
    '}',
  ].join('\n');
  assert.deepEqual(errorTextReads(source, 'web/View.tsx'), [6, 7, 8, 9]);
});

test('calling a method named message is not a read, while stringifying a caught error is', () => {
  const source = [
    'export function View() {',
    '  handler.message(event.data);',
    '  handler?.message?.(event.data);',
    '  try {',
    '    run();',
    '  } catch (caught) {',
    '    show(String(caught));',
    '    show(`failed: $' + '{caught}`);',
    '    show(caught.toString());',
    '    show(String(other));',
    '  }',
    '  return String(event);',
    '}',
  ].join('\n');
  assert.deepEqual(errorTextReads(source, 'web/View.tsx'), [7, 8, 9]);
});

test('an unlisted read fails with its lines, and the core module is exempt', () => {
  withRepository(
    {
      'web/Leak.tsx': 'export const shown = (error: Error) => <p>{error.message}</p>;\n',
      'web/ui-message.ts': 'export const read = (error: Error) => error.message;\n',
      'web/locales/en.ts': 'export const entry = { message: 1 }.message;\n',
    },
    (directory) => {
      const errors = uiMessageErrors(directory, { permanent: {}, debt: {} });
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^web\/Leak\.tsx: 1 error-text reads \(lines 1\), none allowed$/u);
    }
  );
});

test('the debt only shrinks: growth fails, and a stale or generous entry names its new count', () => {
  withRepository(
    {
      'web/Grown.ts': 'export const a = (e: Error) => [e.message, e.message];\n',
      'web/Shrunk.ts': 'export const a = (e: Error) => e.message;\n',
      'web/Clean.ts': 'export const a = 1;\n',
    },
    (directory) => {
      const errors = uiMessageErrors(directory, {
        permanent: {},
        debt: { 'web/Grown.ts': 1, 'web/Shrunk.ts': 3, 'web/Clean.ts': 2 },
      });
      assert.deepEqual(errors, [
        'web/Grown.ts: 2 error-text reads (lines 1, 1), scripts/ui-message-allowlist.json allows 1',
        `${allowlistPath}: web/Shrunk.ts now owes 1 error-text reads; lower its debt from 3 to 1 (node scripts/check-ui-message.mjs --shrink)`,
        `${allowlistPath}: web/Clean.ts owes no error-text reads; remove its debt entry (node scripts/check-ui-message.mjs --shrink)`,
      ]);
    }
  );
});

test('a permanent exception needs a reason, covers its reads first and is never shrunk', () => {
  withRepository(
    {
      'web/Library.ts': 'export const a = (d: { message: string }) => [d.message, d.message];\n',
      'web/Gone.ts': 'export const a = 1;\n',
      [allowlistPath]: `${JSON.stringify({ permanent: { 'web/Library.ts': { count: 1 } } })}\n`,
    },
    (directory) => {
      assert.throws(() => readAllowlist(directory), /permanent "web\/Library\.ts" needs/u);
      const permanent = {
        'web/Library.ts': { count: 1, reason: 'The library names it.' },
        'web/Gone.ts': { count: 1, reason: 'Stored data names it.' },
      };
      const allowlist = { permanent, debt: { 'web/Library.ts': 1 } };
      assert.deepEqual(uiMessageErrors(directory, allowlist), [
        `${allowlistPath}: web/Gone.ts has 0 error-text reads but its permanent entry keeps 1; correct the entry and its reason by hand`,
      ]);
      assert.deepEqual(shrinkAllowlist(directory, allowlist), allowlist);
    }
  );
});

test('shrinking lowers and removes debt but never raises or adds one', () => {
  withRepository(
    {
      'web/Grown.ts': 'export const a = (e: Error) => [e.message, e.message];\n',
      'web/Shrunk.ts': 'export const a = (e: Error) => e.message;\n',
      'web/Unlisted.ts': 'export const a = (e: Error) => e.message;\n',
      'web/Clean.ts': 'export const a = 1;\n',
      [allowlistPath]: '{}\n',
    },
    (directory) => {
      const next = shrinkAllowlist(directory, {
        permanent: {},
        debt: { 'web/Shrunk.ts': 3, 'web/Grown.ts': 1, 'web/Clean.ts': 2 },
      });
      assert.deepEqual(next, { permanent: {}, debt: { 'web/Grown.ts': 1, 'web/Shrunk.ts': 1 } });
      assert.deepEqual(JSON.parse(readFileSync(join(directory, allowlistPath), 'utf8')), next);
      assert.equal(uiMessageErrors(directory).length, 2);
    }
  );
});
