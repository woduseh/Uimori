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
      ].join('\n'),
      'docs/releases/v0.0.1.md': 'This release removed `server/gone.ts`.',
      'server/app.ts': '',
      'server/store.ts': '',
      'server/chat-routes.ts': '',
      'tests/reading.test.ts': '',
    },
    (directory) => {
      const spec = join(directory, 'docs/dev/SPEC.md');
      assert.deepEqual(documentationErrors(directory), [
        `${spec}: \`server/gone.ts\` (no file or directory matches this path)`,
        `${spec}: \`server/*-gone.ts\` (no file or directory matches this path)`,
        `${spec}: \`scripts/<name>.sh\` (no file or directory matches this path)`,
      ]);
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
