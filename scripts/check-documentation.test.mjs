import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentationErrors } from './check-documentation.mjs';

function withDocumentation(files, check) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-doc-links-'));
  try {
    for (const child of [
      '.claude/hooks',
      '.claude/worktrees/copy/docs',
      '.githooks',
      'docs/dev',
      'docs/releases',
      'fixtures',
      'runner',
      'scripts',
      'tests',
      'server',
    ])
      mkdirSync(join(directory, child), { recursive: true });
    const write = (entries) => {
      for (const [file, content] of Object.entries(entries))
        writeFileSync(join(directory, file), content);
    };
    write({ 'README.md': '', 'README.ko.md': '', 'AGENTS.md': '', ...files });
    check(directory, write);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function featureMap(domains) {
  return { 'tests/feature-map.json': JSON.stringify({ version: 1, domains }) };
}

function oneDomainMap(...specs) {
  return {
    'server/app.ts': '',
    ...featureMap({
      editors: {
        title: 'Editors',
        sources: ['server/app.ts'],
        specs: specs.map((file) => ({ file })),
      },
    }),
  };
}

test('current documentation links, anchors, source paths and verification entry points resolve', () => {
  assert.deepEqual(documentationErrors(), []);
});

test('nested guides and verification runners report missing targets without treating URLs as files', () => {
  withDocumentation(
    {
      'README.md': '[guide](docs/releases/nested.md#usage)',
      'README.ko.md': '[안내](docs/ko-missing.md)',
      'AGENTS.md': '[email](mailto:hello@example.invalid)',
      'docs/releases/nested.md':
        '# Usage\n[lost](../missing.md)\n[local](#usage)\n[web](https://example.invalid#top)',
      'scripts/verify-example.mjs': "const files = ['tests/missing.test.ts'];",
    },
    (directory, write) => {
      assert.deepEqual(documentationErrors(directory), [
        `${join(directory, 'README.ko.md')}: docs/ko-missing.md`,
        `${join(directory, 'docs/releases/nested.md')}: ../missing.md`,
        'verify-example.mjs: tests/missing.test.ts',
      ]);
      write({
        'docs/missing.md': '[root](../README.md)',
        'docs/ko-missing.md': '[root](../README.ko.md)',
        'tests/missing.test.ts': '',
      });
      assert.deepEqual(documentationErrors(directory), []);
    }
  );
});

test('anchors must name a heading as GitHub renders it', () => {
  withDocumentation(
    {
      'README.md': [
        '[korean](docs/GUIDE.md#새-채팅-생성-기본값)',
        '[punctuation](docs/GUIDE.md#상세-안내-english)',
        '[code](docs/GUIDE.md#the-read_tools-contract)',
        '[repeated](docs/GUIDE.md#limits-1)',
        '[renamed](docs/GUIDE.md#old-heading)',
        '[fenced](docs/GUIDE.md#not-a-heading)',
        '[third](docs/GUIDE.md#limits-2)',
      ].join('\n'),
      'docs/GUIDE.md': [
        '## 새 채팅 생성 기본값',
        '## 상세 안내 (English)',
        '### The `read_tools` contract',
        '## Limits',
        '## Limits',
        '```sh',
        '# not a heading',
        '```',
        '[self](#limits)',
        '[lost](#gone)',
      ].join('\n'),
    },
    (directory) => {
      assert.deepEqual(documentationErrors(directory), [
        `${join(directory, 'README.md')}: docs/GUIDE.md#old-heading (no heading has the anchor #old-heading)`,
        `${join(directory, 'README.md')}: docs/GUIDE.md#not-a-heading (no heading has the anchor #not-a-heading)`,
        `${join(directory, 'README.md')}: docs/GUIDE.md#limits-2 (no heading has the anchor #limits-2)`,
        `${join(directory, 'docs/GUIDE.md')}: #gone (no heading has the anchor #gone)`,
      ]);
    }
  );
});

test('source paths in inline code must exist outside release notes', () => {
  withDocumentation(
    {
      'docs/dev/SPEC.md': [
        'Entry points: `server/app.ts`, `server/`, `server/*-routes.ts`, `server/{app,store}.ts`.',
        'Add `tests/<feature>.test.ts` next to the others; run `npm test -- tests/gone.test.ts`.',
        'Removed: `server/gone.ts`, `server/*-gone.ts`, `scripts/<name>.sh`.',
        'Not source paths: `data/gone.db`, `uimori call`.',
        'Run `node scripts/run.mjs --files tests/reading.test.ts output/report`.',
        'Hooks: `.claude/hooks/guard.mjs`, `.githooks/pre-push`, `.githooks/gone`.',
        'Local only: `.claude/settings.local.json`, `.claude/worktrees/other/README.md`.',
      ].join('\n'),
      'docs/releases/v0.0.1.md': 'This release removed `server/gone.ts`.',
      '.claude/hooks/guard.mjs': '',
      '.claude/hooks/GUIDE.md': '[lost](../missing.md), `scripts/gone.mjs`.',
      '.claude/worktrees/copy/docs/OLD.md': '[lost](missing.md), `server/gone.ts`.',
      '.githooks/pre-push': '',
      'scripts/run.mjs': '',
      'server/app.ts': '',
      'server/store.ts': '',
      'server/chat-routes.ts': '',
      'tests/reading.test.ts': '',
    },
    (directory) => {
      const spec = join(directory, 'docs/dev/SPEC.md');
      const hookGuide = join(directory, '.claude/hooks/GUIDE.md');
      assert.deepEqual(documentationErrors(directory), [
        `${spec}: \`tests/gone.test.ts\` (no file or directory matches this path)`,
        `${spec}: \`server/gone.ts\` (no file or directory matches this path)`,
        `${spec}: \`server/*-gone.ts\` (no file or directory matches this path)`,
        `${spec}: \`scripts/<name>.sh\` (no file or directory matches this path)`,
        `${spec}: \`.githooks/gone\` (no file or directory matches this path)`,
        `${hookGuide}: ../missing.md`,
        `${hookGuide}: \`scripts/gone.mjs\` (no file or directory matches this path)`,
      ]);
    }
  );
});

test('commands in shell fences must name existing npm scripts and source paths', () => {
  withDocumentation(
    {
      'package.json': JSON.stringify({ scripts: { dev: 'vite', 'verify:browser': 'node x' } }),
      'README.md': ['1. Start:', '   ```powershell', '   npm ci', '   npm run gone', '   ```'].join(
        '\n'
      ),
      'docs/dev/SPEC.md': [
        '```powershell',
        'npm run dev',
        'npm run verify:browser -- --grep READERREC --workers 1',
        'npm run verify:<area>',
        'npm run verify:gone -- --grep reader',
        'node scripts/run.mjs .local/uimori.sqlite --since 2026-10-24',
        'node scripts/gone.mjs --files tests/reading.test.ts tests/gone.test.ts',
        'node scripts/<name>.mjs',
        'node scripts/<name>.sh',
        '# node scripts/commented.mjs',
        'docker compose --env-file .env.self-host up -d',
        '```',
        '```sh',
        'Error: Cannot find module scripts/output.mjs',
        'tests/output.test.ts failed',
        '```',
        '```text',
        'node scripts/sample.mjs',
        'npm run sample',
        '```',
        '```',
        'npm run unlabeled',
        '```',
      ].join('\n'),
      'docs/releases/v0.0.1.md': '```sh\nnode scripts/gone.mjs\nnpm run gone\n```',
      'scripts/run.mjs': '',
      'tests/reading.test.ts': '',
    },
    (directory) => {
      const readme = join(directory, 'README.md');
      const spec = join(directory, 'docs/dev/SPEC.md');
      assert.deepEqual(documentationErrors(directory), [
        `${readme}: npm run gone (package.json has no script named gone)`,
        `${spec}: npm run verify:gone -- --grep reader (package.json has no script named verify:gone)`,
        `${spec}: node scripts/gone.mjs --files tests/reading.test.ts tests/gone.test.ts (no file or directory matches scripts/gone.mjs)`,
        `${spec}: node scripts/gone.mjs --files tests/reading.test.ts tests/gone.test.ts (no file or directory matches tests/gone.test.ts)`,
        `${spec}: node scripts/<name>.sh (no file or directory matches scripts/<name>.sh)`,
      ]);
    }
  );
});

test('inline npm commands and script-shaped names must name existing npm scripts', () => {
  withDocumentation(
    {
      'package.json': JSON.stringify({
        scripts: { verify: 'node x', 'check:i18n': 'node y', 'release:check': 'node z' },
      }),
      'docs/dev/SPEC.md': [
        'Run `npm run verify -- reader`, `npm run check:i18n` or `npm run release:check -- --area <domain>`.',
        'Gone: `npm run verify:ui`, `verify:liquid-gallery` and `check:gone`.',
        'Not scripts: `scene:ready`, `verify:*`, `npm run verify:<area>` and `a:b c`.',
      ].join('\n'),
      'docs/releases/v0.0.1.md': 'Historical: `npm run verify:ui`.',
    },
    (directory) => {
      const spec = join(directory, 'docs/dev/SPEC.md');
      assert.deepEqual(documentationErrors(directory), [
        `${spec}: \`npm run verify:ui\` (package.json has no script named verify:ui)`,
        `${spec}: \`verify:liquid-gallery\` (package.json has no script named verify:liquid-gallery)`,
        `${spec}: \`check:gone\` (package.json has no script named check:gone)`,
      ]);
    }
  );
});

test('case IDs in developer documents, including ranges, must name existing test cases', () => {
  withDocumentation(
    {
      'docs/dev/SPEC.md': [
        'Evidence: `tests/editor-browser.spec.ts` CODEFIELD01-03, `--grep PMUI02` and LIBUI08.',
        'Ranges may repeat the prefix: CBSREF01–CBSREF02. BM25 ranking is not a case. Reversed: CODEFIELD04-01.',
      ].join('\n'),
      'docs/GUIDE.md': 'User guides are not checked: LIBUI09.',
      'docs/releases/v0.0.1.md': 'Release notes are not checked: LIBUI09.',
      ...oneDomainMap('tests/editor-browser.spec.ts'),
      'tests/editor-browser.spec.ts': [
        "test('CODEFIELD01 highlights', () => {});",
        "test('CODEFIELD02 saves', () => {});",
        "test('PMUI02 opens', () => {});",
        "test('CBSREF01 expands', () => {});",
      ].join('\n'),
    },
    (directory) => {
      const spec = join(directory, 'docs/dev/SPEC.md');
      assert.deepEqual(documentationErrors(directory), [
        `${spec}: CODEFIELD01-03 (no test has the case ID CODEFIELD03)`,
        `${spec}: LIBUI08 (no test has the case ID LIBUI08)`,
        `${spec}: CBSREF01–CBSREF02 (no test has the case ID CBSREF02)`,
        `${spec}: CODEFIELD04-01 (case ID range is reversed)`,
      ]);
    }
  );
});

test('case IDs only count when they appear in a test title', () => {
  withDocumentation(
    {
      'docs/dev/SPEC.md': 'Still present in a comment: LIBUI08.',
      ...oneDomainMap('tests/editor-browser.spec.ts'),
      'tests/editor-browser.spec.ts': [
        "test('CODEFIELD01 highlights', () => {});",
        '// leftover LIBUI08 in a comment should not count',
      ].join('\n'),
    },
    (directory) => {
      const spec = join(directory, 'docs/dev/SPEC.md');
      assert.deepEqual(documentationErrors(directory), [
        `${spec}: LIBUI08 (no test has the case ID LIBUI08)`,
      ]);
    }
  );
});

test('every spec file must be registered in the feature map, and registered specs must exist', () => {
  withDocumentation(
    {
      ...oneDomainMap('tests/reading-browser.spec.ts', 'tests/gone-browser.spec.ts'),
      'tests/reading-browser.spec.ts': '',
      'tests/orphan-browser.spec.ts': '',
      'tests/reading.test.ts': '',
    },
    (directory, write) => {
      assert.deepEqual(documentationErrors(directory), [
        'tests/feature-map.json: domain editors names tests/gone-browser.spec.ts, which is not a file in tests/*.spec.ts',
        'tests/feature-map.json: tests/orphan-browser.spec.ts is not registered in any domain',
      ]);
      write(oneDomainMap('tests/reading-browser.spec.ts', 'tests/orphan-browser.spec.ts'));
      assert.deepEqual(documentationErrors(directory), []);
    }
  );
});

test('feature map domains need existing sources and case IDs, known launch options and one home per spec', () => {
  withDocumentation(
    {
      'server/reader.ts': '',
      ...featureMap({
        reader: {
          title: 'Reader',
          sources: ['server/reader*.ts', 'server/gone-*.ts'],
          specs: [
            { file: 'tests/reading-browser.spec.ts', cases: ['READ01', 'READ02'] },
            { file: 'tests/self-host-browser.spec.ts', launch: { runner: 'remote', retries: 2 } },
          ],
        },
        Settings: {
          title: '',
          sources: ['server/reader.ts'],
          specs: [{ file: 'tests/reading-browser.spec.ts', owner: 'nobody' }],
        },
      }),
      'docs/dev/SPEC.md':
        '[reader](../../tests/feature-map.json#reader), [gone](../../tests/feature-map.json#gone)',
      'tests/reading-browser.spec.ts': "test('READ01 opens', () => {});\n// READ02 in a comment",
      'tests/self-host-browser.spec.ts': '',
    },
    (directory) => {
      const spec = join(directory, 'docs/dev/SPEC.md');
      assert.deepEqual(documentationErrors(directory), [
        `${spec}: ../../tests/feature-map.json#gone (the feature map has no domain gone)`,
        'tests/feature-map.json: domain reader source server/gone-*.ts matches no file',
        'tests/feature-map.json: tests/reading-browser.spec.ts has no test titled with the case ID READ02',
        'tests/feature-map.json: domain reader tests/self-host-browser.spec.ts launch.runner has an invalid value',
        'tests/feature-map.json: domain reader tests/self-host-browser.spec.ts launch has unknown option retries',
        'tests/feature-map.json: domain Settings must be lowercase words joined by hyphens',
        'tests/feature-map.json: domain Settings needs a title',
        'tests/feature-map.json: domain Settings tests/reading-browser.spec.ts has unknown field owner',
        'tests/feature-map.json: tests/reading-browser.spec.ts is registered in reader and Settings',
      ]);
    }
  );
});

test('feature map presets name registered specs and a valid grep under their own name', () => {
  const withPresets = (presets) => ({
    'tests/feature-map.json': JSON.stringify({
      version: 1,
      domains: {
        editors: {
          title: 'Editors',
          sources: ['server/app.ts'],
          specs: [{ file: 'tests/reading-browser.spec.ts' }],
        },
      },
      presets,
    }),
  });
  withDocumentation(
    {
      'server/app.ts': '',
      'tests/reading-browser.spec.ts': '',
      ...withPresets({
        editors: { title: 'Editors again', specs: ['tests/reading-browser.spec.ts'] },
        smoke: { title: '', specs: ['tests/gone-browser.spec.ts'], grep: '(', owner: 'x' },
      }),
    },
    (directory, write) => {
      assert.deepEqual(documentationErrors(directory), [
        'tests/feature-map.json: preset editors has the name of a domain',
        'tests/feature-map.json: preset smoke has unknown field owner',
        'tests/feature-map.json: preset smoke needs a title',
        'tests/feature-map.json: preset smoke names tests/gone-browser.spec.ts, which no domain registers',
        'tests/feature-map.json: preset smoke grep is not a regular expression',
      ]);
      write(
        withPresets({
          smoke: { title: 'Smoke', specs: ['tests/reading-browser.spec.ts'], grep: '@smoke' },
        })
      );
      assert.deepEqual(documentationErrors(directory), []);
    }
  );
});

test('user guides directly under docs forbid developer headings, internal paths, and internal API routes', () => {
  withDocumentation(
    {
      'docs/USER.md': [
        '# 사용자 안내',
        '## 구현 참고',
        '### 기술 명세 (English)',
        '### 개발자 참고',
        '## 에이전트 및 구현 참고',
        'Paths: `server/app.ts`, `runner/uimori.mjs`, `fixtures/sample.json`, `tests/reading.test.ts`.',
        'Routes: `POST /api/chats/:id/context`, `/api/helper/tasks/:id/results?limit=10`.',
        'Combined: `GET/PUT /api/chat-generation-defaults`.',
        'Link: [app](../server/app.ts), [guide](GUIDE.md), [site](https://example.invalid/server/app.ts).',
        'Allowed placeholder: `/api/...`.',
        '```sh',
        '## 구현 참고',
        '`server/app.ts`',
        '`POST /api/internal`',
        '```',
      ].join('\n'),
      'docs/SELF-HOST.md': 'Operator route: `GET /api/maintenance` and `/api/session`.',
      'docs/dev/SPEC.md': [
        '## 구현 참고',
        '### 기술 명세 (English)',
        '## 에이전트 및 구현 참고',
        'Internal: `server/app.ts`, `runner/uimori.mjs`, `fixtures/sample.json`, `POST /api/chats/:id/context`.',
        'Combined: `GET/PUT /api/chat-generation-defaults`. Link: [app](../../server/app.ts).',
      ].join('\n'),
      'docs/GUIDE.md': '',
      'server/app.ts': '',
      'runner/uimori.mjs': '',
      'fixtures/sample.json': '',
      'tests/reading.test.ts': '',
    },
    (directory) => {
      const user = join(directory, 'docs/USER.md');
      assert.deepEqual(documentationErrors(directory), [
        `${user}: ../server/app.ts (user guide must not link to internal source paths)`,
        `${user}: user guide must not contain developer heading "## 구현 참고"`,
        `${user}: user guide must not contain developer heading "### 기술 명세 (English)"`,
        `${user}: user guide must not contain developer heading "### 개발자 참고"`,
        `${user}: user guide must not contain developer heading "## 에이전트 및 구현 참고"`,
        `${user}: \`server/app.ts\` (user guide must not reference internal source paths)`,
        `${user}: \`runner/uimori.mjs\` (user guide must not reference internal source paths)`,
        `${user}: \`fixtures/sample.json\` (user guide must not reference internal source paths)`,
        `${user}: \`tests/reading.test.ts\` (user guide must not reference internal source paths)`,
        `${user}: \`POST /api/chats/:id/context\` (user guide must not document internal API routes)`,
        `${user}: \`/api/helper/tasks/:id/results?limit=10\` (user guide must not document internal API routes)`,
        `${user}: \`GET/PUT /api/chat-generation-defaults\` (user guide must not document internal API routes)`,
      ]);
    }
  );
});
