import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  allowlistPath,
  readAllowlist,
  errorTextReads,
  jsonParseCalls,
  jsonParseRemedy,
  plainErrorTexts,
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

test('an Error may carry only literal text, whatever builds or aliases the message', () => {
  const source = [
    "import { message as retainedMessage, t } from './i18n.js';",
    "throw new Error(retainedMessage('transfer.m007'));",
    "throw new Error(t('shared.savedFailure'));",
    'if (invalid) throw new Error(invalid);',
    "reject(new DOMException(t('transfer.m189'), 'AbortError'));",
    'throw Error(`failed: $' + '{detail}`);',
    'class DraftError extends Error {',
    '  constructor(text: string) {',
    '    super(text);',
    '  }',
    '}',
    "throw new Error('FontProvider is missing');",
    'throw new TypeError(`Clipboard unavailable`);',
    "throw new UiError(uiMessage('shared.savedFailure'));",
    "class Known extends Error { constructor() { super('KNOWN'); } }",
    "throw 'raw';",
  ].join('\n');
  assert.deepEqual(plainErrorTexts(source, 'web/View.tsx'), [2, 3, 4, 5, 6, 9, 16]);
});

test('a subclass is held to its own base, and a nested class only to its own', () => {
  const source = [
    'class Many extends AggregateError {',
    "  constructor(errors: Error[]) { super(errors, 'MANY'); }",
    '}',
    'class Mixed extends AggregateError {',
    '  constructor(errors: Error[], text: string) { super(errors, text); }',
    '}',
    'class Outer extends Error {',
    "  constructor() { super('OUTER'); }",
    '  inner = class extends Base {',
    '    constructor(text: string) { super(text); }',
    '  };',
    '}',
    'class Plain extends Base {',
    '  constructor(text: string) {',
    '    super(text);',
    '    this.failure = class extends Error {',
    '      constructor(text: string) { super(text); }',
    '    };',
    '  }',
    '}',
  ].join('\n');
  assert.deepEqual(plainErrorTexts(source, 'web/View.tsx'), [5, 17]);
});

test('an unlisted read fails with its lines, and the core module is exempt', () => {
  withRepository(
    {
      'web/Leak.tsx': 'export const shown = (error: Error) => <p>{error.message}</p>;\n',
      'web/ui-message.ts': 'export const read = (error: Error) => error.message;\n',
      'web/locales/en.ts': 'export const entry = { message: 1 }.message;\n',
    },
    (directory) => {
      const errors = uiMessageErrors(directory, { permanent: {} });
      assert.equal(errors.length, 1);
      assert.match(errors[0], /^web\/Leak\.tsx: 1 error-text reads \(lines 1\), none allowed$/u);
    }
  );
});

test('every reference to JSON.parse counts, and only the JSON boundary module may make one', () => {
  const source = [
    'const a = JSON.parse(text);',
    "const b = JSON['parse'](text);",
    'const c = lines.map(JSON.parse);',
    'const d = JSON?.parse(text);',
    'const e = JSON.stringify(value);',
    'const f = parser.JSON.parse(text);',
    'const g = parseJsonInput(text);',
  ].join('\n');
  assert.deepEqual(jsonParseCalls(source, 'web/View.ts'), [1, 2, 3, 4]);
  withRepository(
    {
      'web/json.ts': 'export const parse = (text: string) => JSON.parse(text);\n',
      'web/ui-message.ts': 'export const read = (text: string) => JSON.parse(text);\n',
      'web/Clean.ts': 'export const a = JSON.stringify({});\n',
    },
    (directory) => {
      assert.deepEqual(uiMessageErrors(directory, { permanent: {} }), [
        `web/ui-message.ts:1: ${jsonParseRemedy}`,
      ]);
    }
  );
});

test('a permanent exception needs a reason and an exact count, and no other section exists', () => {
  withRepository(
    {
      'web/Library.ts': 'export const a = (d: { message: string }) => [d.message, d.message];\n',
      'web/Gone.ts': 'export const a = 1;\n',
      [allowlistPath]: `${JSON.stringify({ permanent: { 'web/Library.ts': { count: 1 } } })}\n`,
    },
    (directory) => {
      assert.throws(() => readAllowlist(directory), /permanent "web\/Library\.ts" needs/u);
      writeFileSync(join(directory, allowlistPath), '{"permanent":{},"debt":{"web/Library.ts":2}}');
      assert.throws(() => readAllowlist(directory), /only a "permanent" section/u);
      const permanent = {
        'web/Library.ts': { count: 1, reason: 'The library names it.' },
        'web/Gone.ts': { count: 1, reason: 'Stored data names it.' },
      };
      assert.deepEqual(uiMessageErrors(directory, { permanent }), [
        `web/Library.ts: 2 error-text reads (lines 1, 1), ${allowlistPath} allows 1`,
        `${allowlistPath}: web/Gone.ts has 0 error-text reads but its permanent entry keeps 1; correct the entry and its reason by hand`,
      ]);
    }
  );
});
