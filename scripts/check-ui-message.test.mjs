import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  allowlistPath,
  readAllowlist,
  errorTextReads,
  jsonParseCalls,
  jsonParseRemedy,
  legacyDescriptorRemedy,
  legacyMessageUses,
  legacyWrapperRemedy,
  plainErrorTexts,
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
      const errors = uiMessageErrors(directory, { permanent: {}, debt: {} });
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
      assert.deepEqual(uiMessageErrors(directory, { permanent: {}, debt: {} }), [
        `web/ui-message.ts:1: ${jsonParseRemedy}`,
      ]);
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

test('legacy uses count wrapper calls and descriptor imports by what is imported, not by name', () => {
  const source = [
    "import { message as retained, t } from './i18n.js';",
    "import { legacyUiMessage as wrap, uiMessage } from './ui-message.js';",
    "import { errorDescriptor } from './api-errors.js';",
    "import { messageRef } from './elsewhere.js';",
    'const legacyUiMessage = (text: string) => text;',
    "export const a = [wrap(retained('k')), wrap(''), legacyUiMessage(t('k')), uiMessage('k')];",
  ].join('\n');
  assert.deepEqual(legacyMessageUses(source, 'web/View.tsx'), {
    apis: ['errorDescriptor', 'message'],
    wrappers: 2,
  });
  assert.deepEqual(
    legacyMessageUses("import { translateMessage } from '../i18n.js';\n", 'web/helper/View.tsx'),
    { apis: ['translateMessage'], wrappers: 0 }
  );
});

test('every way of reaching the wrapper or a descriptor API counts, not only a direct call', () => {
  const uses = (lines) => legacyMessageUses(lines.join('\n'), 'web/View.tsx');
  const wrapper = "import { legacyUiMessage } from './ui-message.js';";
  assert.deepEqual(uses([wrapper, 'export const a = texts.map(legacyUiMessage);']), {
    apis: [],
    wrappers: 1,
  });
  assert.equal(uses([wrapper, 'export const a = legacyUiMessage?.(text);']).wrappers, 1);
  assert.equal(
    uses([wrapper, 'const w = legacyUiMessage;', 'const v = w;', 'export const a = [w(x), v(y)];'])
      .wrappers,
    4
  );
  assert.equal(
    uses([
      "import { legacyUiMessage as one, legacyUiMessage as two } from './ui-message.js';",
      'export const a = [one(x), two(y)];',
    ]).wrappers,
    2
  );
  assert.deepEqual(
    uses([
      "import * as ui from './ui-message.js';",
      "import * as i18n from './i18n.js';",
      'export const a = [ui.legacyUiMessage(x), ui?.["legacyUiMessage"](y), i18n.translateMessage(s)];',
      'const { messageRef, legacyUiMessage: w } = i18n;',
      'const { legacyUiMessage: z } = ui;',
      'export const b = [z(x), i18n.t(k)];',
    ]),
    { apis: ['messageRef', 'translateMessage'], wrappers: 4 }
  );
  assert.deepEqual(
    uses([
      "export { legacyUiMessage, legacyMessageString } from './ui-message.js';",
      "export * from './i18n.js';",
    ]),
    { apis: ['legacyMessageString', 'message', 'messageRef', 'translateMessage'], wrappers: 1 }
  );
});

test('legacy wrappers and descriptor files only shrink, and shrinking drops an emptied section', () => {
  const wrapping = "import { legacyUiMessage } from './ui-message.js';\n";
  withRepository(
    {
      'web/Grown.tsx': `${wrapping}export const a = [legacyUiMessage('a'), legacyUiMessage('b')];\n`,
      'web/Shrunk.tsx': `${wrapping}export const a = legacyUiMessage('a');\n`,
      'web/New.tsx':
        "import { translateMessage } from './i18n.js';\nexport const a = translateMessage;\n",
      'web/Clean.tsx': 'export const a = 1;\n',
      'web/i18n.ts': 'export const message = (key: string) => key;\n',
      [allowlistPath]: '{}\n',
    },
    (directory) => {
      const allowlist = {
        permanent: {},
        debt: {},
        legacyWrappers: { 'web/Grown.tsx': 1, 'web/Shrunk.tsx': 3, 'web/Clean.tsx': 1 },
        legacyDescriptors: ['web/Clean.tsx'],
      };
      const shrink = '(node scripts/check-ui-message.mjs --shrink)';
      assert.deepEqual(uiMessageErrors(directory, allowlist), [
        `web/Grown.tsx: 2 legacyUiMessage uses, ${allowlistPath} allows 1; ${legacyWrapperRemedy}`,
        `${allowlistPath}: web/Shrunk.tsx now has 1 legacyUiMessage uses; lower legacyWrappers from 3 to 1 ${shrink}`,
        `${allowlistPath}: web/Clean.tsx has no legacyUiMessage uses; remove its legacyWrappers entry ${shrink}`,
        `web/New.tsx: uses the legacy descriptor API (translateMessage) but is not in legacyDescriptors; ${legacyDescriptorRemedy}`,
        `${allowlistPath}: web/Clean.tsx no longer uses a legacy descriptor API; remove it from legacyDescriptors ${shrink}`,
      ]);
      assert.deepEqual(shrinkAllowlist(directory, allowlist), {
        permanent: {},
        debt: {},
        legacyWrappers: { 'web/Grown.tsx': 1, 'web/Shrunk.tsx': 1 },
      });
    }
  );
});
