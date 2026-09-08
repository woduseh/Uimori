import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';

const owned: { store: Store; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const within = relative(resolve(tmpdir()), resolve(directory));
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-history-storage-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-history-storage-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  owned.push({ store, directory });
  const chat = createFixtureChat(store, 'Synthetic history');
  return { store, chat };
}
function append(store: Store, chatId: string, text: string, branchId?: string) {
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId, branchId);
  const run = store.createRun(
    chatId,
    {
      request: 'Synthetic history',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
      branchId: branch.id,
    },
    (current) => ({
      chatId,
      request: 'Synthetic history',
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      history: store.history(current.headRevision),
      resources: [],
      branchId: branch.id,
    })
  ).run;
  store.startRun(run.id);
  return store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}

test('history preserves exact original/latest edit, source-time policy, branch order and immutable run snapshots', () => {
  const { store, chat } = fixture();
  const first = append(store, chat.id, '첫 문단 😀\r\n\r\n```txt\r\n원문\r\n\r\n```');
  const second = append(store, chat.id, 'Second scene');
  const branch = store.product.createBranch(chat.id, { title: 'Other', fromRevision: first.id });
  const other = append(store, chat.id, 'Other branch', branch.id);
  const policy = createSourceSegmentFixture();
  store.db
    .prepare("UPDATE runs SET snapshot=json_set(snapshot,'$.sourceSegments',json(?)) WHERE id=?")
    .run(JSON.stringify(policy), first.runId);
  const frozen = store.run(second.runId).snapshot;
  const edited = store.editSource(first.id, {
    expectedRevision: 0,
    text: '수정된 문단\n\n둘째 문단 😀',
  });
  store.editSource(first.id, { expectedRevision: 1, text: '최신 수정\r\n공백 보존  😀' });
  const latest = store.source(first.id);
  expect(latest.hash).not.toBe(edited.hash);
  const expected = {
    revision: first.id,
    text: latest.text,
    contentHash: latest.hash,
    sourceSegments: policy,
  };
  expect(store.history(second.id)).toEqual([expected, { revision: second.id, text: second.text }]);
  expect(store.history(other.id)).toEqual([expected, { revision: other.id, text: other.text }]);
  expect(store.run(second.runId).snapshot).toEqual(frozen);
  expect(store.sourceOriginal(first.id).text).toBe(first.text);
  expect(store.validateHistory(frozen.history, first.id)).toBe(true);
  store.editSource(first.id, { expectedRevision: 2, text: first.text });
  expect(store.history(first.id)).toEqual([
    { revision: first.id, text: first.text, sourceSegments: policy },
  ]);
  expect(store.history(null)).toEqual([]);
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('history still rejects missing ancestors and ancestry cycles', () => {
  const { store, chat } = fixture();
  const first = append(store, chat.id, 'Original');
  const second = append(store, chat.id, 'Second');
  expect(() => store.history('missing')).toThrow('Source not found');
  store.db.prepare('UPDATE sources SET parent_revision=? WHERE id=?').run(second.id, first.id);
  expect(() => store.history(second.id)).toThrow('Source ancestry cycle');
});

test.each(['original-hash', 'original-blank', 'edit-hash', 'edit-blank'])(
  'history preserves source identity validation for %s corruption',
  (kind) => {
    const { store, chat } = fixture();
    const source = append(store, chat.id, 'Original');
    const blankHash = createHash('sha256').update('  ').digest('hex');
    if (kind.startsWith('edit')) {
      store.editSource(source.id, { expectedRevision: 0, text: 'Edited' });
      store.db
        .prepare('UPDATE source_edits SET text=?,hash=? WHERE source_id=?')
        .run(
          kind === 'edit-blank' ? '  ' : 'Edited',
          kind === 'edit-blank' ? blankHash : 'bad',
          source.id
        );
    } else {
      // Original identity must still be checked even when a valid latest edit exists.
      store.editSource(source.id, { expectedRevision: 0, text: 'Edited' });
      store.db
        .prepare('UPDATE sources SET text=?,hash=? WHERE id=?')
        .run(
          kind === 'original-blank' ? '  ' : 'Original',
          kind === 'original-blank' ? blankHash : 'bad',
          source.id
        );
    }
    expect(() => store.history(source.id)).toThrow('SOURCE_IDENTITY_INVALID');
  }
);
