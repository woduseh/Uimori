import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import {
  readChatVariables,
  writeChatVariables,
  writeChatVariablesInTransaction,
  type ChatVariableCommand,
} from '../server/chat-variables.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { store: Store; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const within = relative(resolve(tmpdir()), resolve(directory));
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-chat-variables-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-chat-variables-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  owned.push({ store, directory });
  const chat = createFixtureChat(store, 'Synthetic variables');
  return { store, chat };
}
function command(
  values: Record<string, string> = { score: '0' },
  expectedRevision = 0
): ChatVariableCommand {
  return { values, expectedRevision, expectedSourceHash: null, idempotencyKey: randomUUID() };
}
function reserve(store: Store, chatId: string) {
  const chat = store.chat(chatId);
  return store.createRun(
    chatId,
    {
      request: 'Synthetic source',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      request: 'Synthetic source',
      parentRevision: chat.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      history: store.history(chat.headRevision),
      resources: [],
    })
  ).run;
}
function append(store: Store, chatId: string, text = 'Synthetic source') {
  const run = reserve(store, chatId);
  store.startRun(run.id);
  return store.completeRun(run.id, text, {
    modelCalls: 0,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
}

test('untouched chat reads are pure and chat states stay separate', () => {
  const { store, chat } = fixture();
  const before = store.db.prepare('SELECT * FROM profiles').all();
  expect(readChatVariables(store, chat.id)).toEqual({ revision: 0, values: {} });
  expect(store.db.prepare('SELECT * FROM chat_variable_states').all()).toEqual([]);
  expect(store.db.prepare('SELECT * FROM profiles').all()).toEqual(before);
  const other = createFixtureChat(store, 'Other');
  writeChatVariables(store, other.id, command());
  expect(readChatVariables(store, chat.id)).toEqual({ revision: 0, values: {} });
  expect(readChatVariables(store, other.id).revision).toBe(1);
});

test('explicit equal-value writes advance revision and stale ABA commands fail', () => {
  const { store, chat } = fixture();
  for (const [revision, score] of ['1', '2', '1', '1'].entries())
    expect(writeChatVariables(store, chat.id, command({ score }, revision)).revision).toBe(
      revision + 1
    );
  expect(() => writeChatVariables(store, chat.id, command({ score: '3' }, 1))).toThrow(
    'CHAT_VARIABLE_REVISION_CONFLICT'
  );
  expect(store.db.prepare('SELECT count(*) AS n FROM chat_variable_journal').get()!.n).toBe(4);
});

test('a repeated command acknowledges current state without overwriting later variables', () => {
  const { store, chat } = fixture();
  const input = command({ z: '2', a: '1' });
  writeChatVariables(store, chat.id, input);
  writeChatVariables(store, chat.id, command({ a: 'other' }, 1));
  append(store, chat.id);
  reserve(store, chat.id);
  expect(writeChatVariables(store, chat.id, { ...input, values: { a: '1', z: '2' } })).toEqual({
    revision: 2,
    values: { a: 'other' },
  });
  expect(() => writeChatVariables(store, chat.id, { ...input, values: {} })).toThrow(
    'CHAT_VARIABLE_IDEMPOTENCY_CONFLICT'
  );
  expect(readChatVariables(store, chat.id).revision).toBe(2);
});

test('CAS uses latest source edit hash and validates source chat ownership', () => {
  const { store, chat } = fixture();
  const source = append(store, chat.id);
  const input = { ...command(), expectedSourceHash: source.hash };
  const edited = store.editSource(source.id, { expectedRevision: 0, text: 'Edited source' });
  expect(() => writeChatVariables(store, chat.id, input)).toThrow('CHAT_VARIABLE_SOURCE_CONFLICT');
  expect(
    writeChatVariables(store, chat.id, { ...input, expectedSourceHash: edited.hash }).revision
  ).toBe(1);
  const other = createFixtureChat(store, 'Other');
  const otherSource = append(store, other.id);
  store.db.prepare('UPDATE chats SET head_revision=? WHERE id=?').run(otherSource.id, chat.id);
  expect(() =>
    writeChatVariables(store, chat.id, {
      ...command({}, 1),
      expectedSourceHash: otherSource.hash,
    })
  ).toThrow('CHAT_VARIABLE_SOURCE_OWNER');
});

test.each(['queued', 'running'])('new user writes reject an active %s Run', (status) => {
  const { store, chat } = fixture();
  const run = reserve(store, chat.id);
  store.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, run.id);
  expect(() => writeChatVariables(store, chat.id, command())).toThrow('CHAT_VARIABLE_CHAT_BUSY');
  expect(store.db.prepare('SELECT * FROM chat_variable_states').all()).toEqual([]);
});

test('host adoption requires a transaction and rolls state, receipt and event back together', () => {
  const { store, chat } = fixture();
  const input = command();
  expect(() => writeChatVariablesInTransaction(store, chat.id, input)).toThrow(
    'CHAT_VARIABLE_TRANSACTION_REQUIRED'
  );
  reserve(store, chat.id);
  const beforeEvents = store.db.prepare('SELECT * FROM events').all();
  expect(() =>
    store.transaction(() => {
      writeChatVariablesInTransaction(store, chat.id, input);
      throw new Error('Synthetic rollback');
    })
  ).toThrow('Synthetic rollback');
  expect(store.db.prepare('SELECT * FROM chat_variable_states').all()).toEqual([]);
  expect(store.db.prepare('SELECT * FROM chat_variable_journal').all()).toEqual([]);
  expect(store.db.prepare('SELECT * FROM events').all()).toEqual(beforeEvents);
  expect(
    store.transaction(() => writeChatVariablesInTransaction(store, chat.id, input)).revision
  ).toBe(1);
});

test('invalid maps and malformed commands leave no write receipts', () => {
  const { store, chat } = fixture();
  for (const values of [
    JSON.parse('{"__proto__":"bad"}'),
    { score: 1 },
    { score: 'x'.repeat(200001) },
  ])
    expect(() => writeChatVariables(store, chat.id, command(values))).toThrow();
  for (const change of [
    { expectedRevision: -1 },
    { expectedSourceHash: '' },
    { idempotencyKey: '' },
  ])
    expect(() => writeChatVariables(store, chat.id, { ...command(), ...change })).toThrow();
  expect(store.db.prepare('SELECT * FROM chat_variable_journal').all()).toEqual([]);
});
