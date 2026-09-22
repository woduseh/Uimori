import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { readRunStatus, readRunSnapshot } from '../server/run-projections.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { importChatTranscript } from '../server/chat-transcript.js';
const owned: { path: string; store: Store }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store.close();
    rmSync(item.path, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-projections-'));
  const store = new Store(join(path, 'app.sqlite'));
  owned.push({ path, store });
  const bot = store.product.content(fixtureBotInput('Bot', 'Current bot text'));
  const { chat } = importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: 'Story',
      notes: [],
      packageAttachments: [{ id: bot.id, revision: 1, role: 'bot' }],
      entries: [
        { request: 'One', text: 'a'.repeat(20000), translation: null },
        { request: 'Two', text: 'b'.repeat(20000), translation: null },
      ],
    },
  });
  const source = store.source(chat.headRevision!);
  return { store, chat, source };
}
test('status queries never hydrate snapshots or diagnostic payloads', () => {
  const { store, source } = fixture();
  store.db
    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
    .run('deliberately not JSON', source.runId);
  expect(readRunStatus(store, source.runId)).toBe('completed');
  expect(() => readRunStatus(store, 'missing')).toThrow('Run not found');
});
test('completed rows have bounded metadata; explicit context reads reconstruct messages and current resources', () => {
  const { store, source } = fixture();
  const row = store.db.prepare('SELECT snapshot FROM runs WHERE id=?').get(source.runId)!;
  const saved = JSON.parse(String(row.snapshot));
  expect(saved.settled).toBe(true);
  expect(saved.history).toEqual([]);
  expect(String(row.snapshot).length).toBeLessThan(5000);
  const context = readRunSnapshot(store, source.runId);
  expect(context.history).toHaveLength(1);
  expect(context.history[0]!.text).toBe('a'.repeat(20000));
  expect(context.profile?.packages?.[0]?.body).toBe('Current bot text');
  expect(
    store.db.prepare('SELECT snapshot AS renamed FROM runs WHERE id=?').get(source.runId)!.renamed
  ).toBe(row.snapshot);
});
