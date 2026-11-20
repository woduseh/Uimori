import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { allowlistPath, commentErrors, readAllowlist, remedy } from './check-comments.mjs';

function withRepository(files, check) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-comments-'));
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

test('directives, license text, and sourced comments pass while narration fails with its location', () => {
  withRepository(
    {
      'core/allowed.ts': [
        '// biome-ignore lint/suspicious/noExplicitAny: the fixture crosses an untyped boundary',
        'export const loose: any = 1;',
        '// @ts-expect-error a number is not a string',
        'export const wrong: string = 1;',
        '/** SPDX-License-Identifier: MIT */',
        '// https://example.invalid/spec (2026-11-20): the service rejects empty batches,',
        '// so the caller sends at least one item.',
        "export const url = 'https://example.invalid/not-a-comment // still a string';",
      ].join('\n'),
      'web/View.tsx': [
        'export function View() {',
        '  return (',
        '    <div>',
        '      {/* The modal closes itself. */}',
        '    </div>',
        '  );',
        '}',
      ].join('\n'),
      'web/style.css': [
        '.a::before { content: "/* not a comment */"; }',
        '/* Section header */',
        '.b { color: red; }',
      ].join('\n'),
      'server/legacy.mjs': [
        '// @ts-ignore is not an allowed directive',
        'export const x = 1;',
        '// biome-ignore lint/style/useConst: reassigned by the loader',
        '// and this narration line is judged on its own.',
        'export let y = 2;',
      ].join('\n'),
      'third_party/vendor.ts': '// Outside the checked directories.\n',
      'web/node_modules/pkg/index.js': '// Installed code is not checked.\n',
    },
    (directory) => {
      assert.deepEqual(commentErrors(directory, []), [
        'web/View.tsx:4: /* The modal closes itself. */',
        'web/style.css:2: /* Section header */',
        'server/legacy.mjs:1: // @ts-ignore is not an allowed directive',
        'server/legacy.mjs:4: // and this narration line is judged on its own.',
      ]);
    }
  );
});

test('the allowlist matches whole comment text regardless of layout and reports entries that no longer match', () => {
  withRepository(
    {
      'tests/browser.spec.ts': [
        'test("drag", () => {',
        '    // Playwright scrolls the drag target while the mouse is down',
        '    // but before the first movement.',
        '});',
        '// The OS releases this lock when the process exits.',
      ].join('\n'),
    },
    (directory) => {
      const allowlist = [
        {
          file: 'tests/browser.spec.ts',
          comment:
            'Playwright scrolls the drag target while the mouse is down but before the first movement.',
          system: 'Playwright',
        },
        {
          file: 'tests/browser.spec.ts',
          comment: 'The OS releases this lock when the process ends.',
          system: 'OS file locks',
        },
      ];
      assert.deepEqual(commentErrors(directory, allowlist), [
        'tests/browser.spec.ts:5: // The OS releases this lock when the process exits.',
        `${allowlistPath}: no matching comment in tests/browser.spec.ts; remove the entry: The OS releases this lock when the process ends.`,
      ]);
    }
  );
});

test('every allowlist entry names the external system it describes', () => {
  withRepository(
    {
      [allowlistPath]: JSON.stringify([{ file: 'web/a.ts', comment: 'Chromium rounds.' }]),
    },
    (directory) => {
      assert.throws(() => readAllowlist(directory), /external "system"/u);
    }
  );
});

test('the failure message says what to do instead of keeping the comment', () => {
  assert.match(remedy, /commit body/u);
  assert.match(remedy, /\/\/ <URL> \(<YYYY-MM-DD>\): <fact>/u);
  assert.match(remedy, new RegExp(allowlistPath.replaceAll('.', '\\.'), 'u'));
});
