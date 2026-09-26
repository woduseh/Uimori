import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { captureLogicalHistory } from '../server/prompt-snapshot.js';
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

test('logical history reads the captured original or older edit instead of the current source version', () => {
  const { store, chat } = fixture();
  const original = append(store, chat.id, 'Original manuscript 😀\r\n\r\nSecond paragraph.');
  const capturedEdit = store.editSource(original.id, {
    expectedRevision: 0,
    text: 'Earlier user edit 😀\r\n\r\nKeep this wording.',
  });
  const current = store.editSource(original.id, {
    expectedRevision: 1,
    text: 'A newer edit must not replace the captured version.',
  });
  const snapshot = store.run(original.runId).snapshot;
  for (const entry of [
    { revision: original.id, text: original.text },
    { revision: original.id, text: original.text, contentHash: original.hash },
    { revision: original.id, text: capturedEdit.text, contentHash: capturedEdit.hash },
  ]) {
    const logical = captureLogicalHistory(store, { ...snapshot, history: [entry] });
    expect(logical).toEqual([
      {
        id: `request:${original.id}`,
        role: 'user',
        text: 'Synthetic history',
        sourceRevision: original.id,
        sourceHash: entry.contentHash ?? original.hash,
        runId: original.runId,
      },
      {
        id: `source:${original.id}`,
        role: 'assistant',
        text: entry.text,
        sourceRevision: original.id,
        sourceHash: entry.contentHash ?? original.hash,
        runId: original.runId,
      },
    ]);
  }
  expect(store.source(original.id).text).toBe(current.text);
  expect(() =>
    captureLogicalHistory(store, {
      ...snapshot,
      history: [{ revision: original.id, text: current.text, contentHash: '0'.repeat(64) }],
    })
  ).toThrow('Unknown source content hash');
  expect(() =>
    captureLogicalHistory(store, {
      ...snapshot,
      history: [{ revision: 'missing', text: original.text }],
    })
  ).toThrow('Source not found');
});

test.each(['original', 'captured-edit'] as const)(
  'logical history rejects a tampered %s even when the latest edit is valid',
  (corrupted) => {
    const { store, chat } = fixture();
    const original = append(store, chat.id, 'Original manuscript.');
    const selected = store.editSource(original.id, {
      expectedRevision: 0,
      text: 'Captured earlier edit.',
    });
    store.editSource(original.id, { expectedRevision: 1, text: 'Valid latest edit.' });
    const snapshot = store.run(original.runId).snapshot;
    if (corrupted === 'original')
      store.db
        .prepare('UPDATE sources SET text=? WHERE id=?')
        .run('Tampered original', original.id);
    else
      store.db
        .prepare('UPDATE source_edits SET text=? WHERE source_id=? AND revision=1')
        .run('Tampered captured edit', original.id);
    expect(() =>
      captureLogicalHistory(store, {
        ...snapshot,
        history: [{ revision: original.id, text: selected.text, contentHash: selected.hash }],
      })
    ).toThrow('SOURCE_IDENTITY_INVALID');
  }
);
