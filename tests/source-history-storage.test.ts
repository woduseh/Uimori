import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';

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
