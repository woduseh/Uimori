import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classesOf,
  docsOnly,
  is,
  sourceRoots,
  windowsSensitive,
  withoutModuleExtension,
} from './change-classifier.mjs';

const classTable = {
  'core/provider.ts': [
    'biomeFile',
    'typeScriptInput',
    'moduleFile',
    'commentSource',
    'browserInput',
  ],
  'packages/contracts/src/index.ts': [
    'biomeFile',
    'typeScriptInput',
    'moduleFile',
    'commentSource',
    'browserInput',
  ],
  'server/app.ts': [
    'biomeFile',
    'typeScriptInput',
    'moduleFile',
    'commentSource',
    'distEntry',
    'browserInput',
  ],
  'server/routes/chat.ts': [
    'biomeFile',
    'typeScriptInput',
    'moduleFile',
    'commentSource',
    'browserInput',
  ],
  'web/ChatComposer.tsx': [
    'biomeFile',
    'typeScriptInput',
    'moduleFile',
    'commentSource',
    'i18nInput',
    'browserInput',
    'windowsInsensitive',
  ],
  'web/styles.css': [
    'biomeFile',
    'commentSource',
    'i18nInput',
    'browserInput',
    'windowsInsensitive',
  ],
  'web/help.md': ['markdownFile', 'i18nInput', 'browserInput', 'windowsInsensitive'],
  'runner/runner.mjs': ['biomeFile', 'moduleFile', 'commentSource', 'browserInput'],
  'tests/server.test.ts': [
    'biomeFile',
    'typeScriptInput',
    'moduleFile',
    'commentSource',
    'vitestFile',
  ],
  'tests/helper/nested.test.ts': [
    'biomeFile',
    'typeScriptInput',
    'moduleFile',
    'commentSource',
    'vitestFile',
  ],
  'tests/chat-composer-browser.spec.ts': [
    'biomeFile',
    'typeScriptInput',
    'moduleFile',
    'commentSource',
    'browserInput',
    'windowsInsensitive',
  ],
  'tests/nested/browser.spec.ts': ['biomeFile', 'typeScriptInput', 'moduleFile', 'commentSource'],
  'tests/fixtures/chat.json': ['biomeFile', 'browserInput'],
  'tests/feature-map.json': ['biomeFile'],
  'tests/build-runner.node.test.mjs': [
    'biomeFile',
    'moduleFile',
    'commentSource',
    'toolingTestFile',
  ],
  'scripts/doctor.mjs': [
    'biomeFile',
    'moduleFile',
    'commentSource',
    'scriptFile',
    'topLevelScript',
  ],
  'scripts/doctor.test.mjs': [
    'biomeFile',
    'moduleFile',
    'commentSource',
    'toolingTestFile',
    'scriptFile',
    'topLevelScript',
  ],
  'scripts/helpers/nested.mjs': ['biomeFile', 'moduleFile', 'commentSource', 'scriptFile'],
  'scripts/build.mjs': [
    'biomeFile',
    'moduleFile',
    'commentSource',
    'fullSuiteInput',
    'scriptFile',
    'topLevelScript',
  ],
  'scripts/build-runner.mjs': [
    'biomeFile',
    'moduleFile',
    'commentSource',
    'fullSuiteInput',
    'scriptFile',
    'topLevelScript',
  ],
  'scripts/check-comments.mjs': [
    'biomeFile',
    'moduleFile',
    'commentSource',
    'fullCommentScan',
    'scriptFile',
    'topLevelScript',
  ],
  'scripts/comment-allowlist.json': [
    'biomeFile',
    'fullCommentScan',
    'scriptFile',
    'topLevelScript',
  ],
  'scripts/check-i18n.mjs': [
    'biomeFile',
    'moduleFile',
    'commentSource',
    'i18nInput',
    'scriptFile',
    'topLevelScript',
  ],
  'package.json': ['biomeFile', 'typeScriptInput', 'fullSuiteInput'],
  'package-lock.json': ['biomeFile', 'fullSuiteInput'],
  'tsconfig.json': ['biomeFile', 'typeScriptInput', 'fullSuiteInput'],
  'tsconfig.web.json': ['biomeFile', 'typeScriptInput', 'fullSuiteInput'],
  'biome.json': ['biomeFile', 'fullSuiteInput'],
  'vitest.config.ts': ['biomeFile', 'typeScriptInput', 'commentSource', 'fullSuiteInput'],
  'playwright.config.ts': ['biomeFile', 'typeScriptInput', 'commentSource', 'browserInput'],
  'docs/READING.md': ['markdownFile', 'userGuide', 'windowsInsensitive'],
  'docs/sub/NESTED.md': ['markdownFile', 'windowsInsensitive'],
  'docs/dev/CHECKS.md': ['markdownFile', 'inertDocumentation', 'windowsInsensitive'],
  'docs/dev/sub/NESTED.md': ['markdownFile', 'inertDocumentation', 'windowsInsensitive'],
  'docs/plans/ux-redesign.md': ['markdownFile', 'inertDocumentation', 'windowsInsensitive'],
  'docs/releases/v0.18.1.md': ['markdownFile', 'inertDocumentation', 'windowsInsensitive'],
  'docs/page.mdx': [],
  'docs/example.ts': ['biomeFile', 'typeScriptInput', 'commentSource'],
  'README.md': ['markdownFile', 'inertDocumentation', 'windowsInsensitive'],
  'README.ko.md': ['markdownFile', 'inertDocumentation', 'windowsInsensitive'],
  'AGENTS.md': ['markdownFile', 'inertDocumentation', 'windowsInsensitive'],
  LICENSE: ['inertDocumentation', 'windowsInsensitive'],
  '.githooks/pre-push.mjs': ['biomeFile', 'commentSource', 'hookFile'],
  '.claude/hooks/release-guard.mjs': ['biomeFile', 'commentSource', 'hookFile'],
  '.github/workflows/quality.yml': [],
};

test('each kind of path falls into the classes its rules are meant for', () => {
  for (const [file, expected] of Object.entries(classTable))
    assert.deepEqual(classesOf(file).sort(), [...expected].sort(), file);
});

test('module files are the TypeScript and JavaScript sources under the source roots only', () => {
  for (const root of sourceRoots) {
    assert.equal(is.moduleFile(`${root}/a.ts`), true, root);
    assert.equal(is.moduleFile(`${root}/deep/a.mjs`), true, root);
    assert.equal(is.moduleFile(`${root}/a.json`), false, root);
    assert.equal(is.moduleFile(`${root}/a.css`), false, root);
    assert.equal(is.moduleFile(`${root}/a.cjs`), false, root);
    assert.equal(is.moduleFile(`${root}.ts`), false, root);
  }
  assert.equal(is.moduleFile('docs/a.ts'), false);
  assert.equal(is.moduleFile('fixtures/a.ts'), false);
  assert.equal(is.moduleFile('third_party/a.ts'), false);
});

test('module extensions are removed so an import stem matches its source file', () => {
  for (const [file, stem] of [
    ['core/provider.ts', 'core/provider'],
    ['web/App.tsx', 'web/App'],
    ['scripts/ci-changes.mjs', 'scripts/ci-changes'],
    ['scripts/legacy.cjs', 'scripts/legacy'],
    ['scripts/data.json', 'scripts/data.json'],
  ])
    assert.equal(withoutModuleExtension(file), stem);
});

test('only inert documentation counts as documentation-only, and an empty change set never does', () => {
  assert.equal(docsOnly([]), false);
  assert.equal(docsOnly(['LICENSE', 'docs/dev/CHECKS.md']), true);
  assert.equal(docsOnly(['LICENSE', 'docs/READING.md']), false);
  assert.equal(docsOnly(['docs/dev/CHECKS.md', 'web/help.md']), false);
});

test('an empty change set and any file outside web, documentation and browser specs are Windows sensitive', () => {
  assert.equal(windowsSensitive([]), true);
  assert.equal(windowsSensitive(['web/styles.css', 'tests/chat-composer-browser.spec.ts']), false);
  assert.equal(windowsSensitive(['web/styles.css', 'tests/server.test.ts']), true);
  assert.equal(windowsSensitive(['docs/READING.md', 'package.json']), true);
});
