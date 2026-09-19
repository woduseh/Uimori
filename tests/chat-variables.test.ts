import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import {
  checkpointChatVariablesInTransaction,
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
  const branch = store.product.branch(chat.id);
  return { store, chat, branch };
}
function command(
  values: Record<string, string> = { score: '0' },
  expectedRevision = 0
): ChatVariableCommand {
  return { values, expectedRevision, expectedSourceHash: null, idempotencyKey: randomUUID() };
}
function reserve(store: Store, chatId: string, branchId: string) {
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId, branchId);
  return store.createRun(
    chatId,
    {
      request: 'Synthetic source',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      branchId,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      request: 'Synthetic source',
      parentRevision: branch.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      history: store.history(branch.headRevision),
      resources: [],
      branchId,
    })
  ).run;
}
function append(store: Store, chatId: string, branchId: string, text = 'Synthetic source') {
  const run = reserve(store, chatId, branchId);
  store.startRun(run.id);
  return store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}

test('untouched branch reads are pure and reject cross-chat ownership', () => {
  const { store, chat, branch } = fixture();
  const before = store.db.prepare('SELECT * FROM profiles').all();
  expect(readChatVariables(store, chat.id, branch.id)).toEqual({ revision: 0, values: {} });
  expect(store.db.prepare('SELECT * FROM chat_variable_states').all()).toEqual([]);
  expect(store.db.prepare('SELECT * FROM profiles').all()).toEqual(before);
  const other = createFixtureChat(store, 'Other');
  expect(() => readChatVariables(store, other.id, branch.id)).toThrow('Branch not found');
  expect(() => writeChatVariables(store, other.id, branch.id, command())).toThrow(
    'Branch not found'
  );
});

test('writes replace only branch overrides and return detached maps', () => {
  const { store, chat, branch } = fixture();
  const other = store.product.createBranch(chat.id, { title: 'Other', fromRevision: null });
  const input = command({ score: '2', blank: '' });
  const result = writeChatVariables(store, chat.id, branch.id, input);
  input.values.score = 'changed input';
  result.values.blank = 'changed output';
  expect(readChatVariables(store, chat.id, branch.id)).toEqual({
    revision: 1,
    values: { score: '2', blank: '' },
  });
  expect(readChatVariables(store, chat.id, other.id)).toEqual({ revision: 0, values: {} });
  expect(writeChatVariables(store, chat.id, branch.id, command({}, 1))).toEqual({
    revision: 2,
    values: {},
  });
});

test('explicit equal-value writes advance revision and stale ABA commands fail', () => {
  const { store, chat, branch } = fixture();
  for (const [revision, score] of ['1', '2', '1', '1'].entries())
    expect(
      writeChatVariables(store, chat.id, branch.id, command({ score }, revision)).revision
    ).toBe(revision + 1);
  expect(() => writeChatVariables(store, chat.id, branch.id, command({ score: '3' }, 1))).toThrow(
    'CHAT_VARIABLE_REVISION_CONFLICT'
  );
  expect(store.db.prepare('SELECT count(*) AS n FROM chat_variable_journal').get()!.n).toBe(4);
});

test('same receipt replays after head, state and active work change; changed commands conflict', () => {
  const { store, chat, branch } = fixture();
  const input = command({ z: '2', a: '1' });
  const result = writeChatVariables(store, chat.id, branch.id, input);
  writeChatVariables(store, chat.id, branch.id, command({ a: 'other' }, 1));
  append(store, chat.id, branch.id);
  reserve(store, chat.id, branch.id);
  expect(
    writeChatVariables(store, chat.id, branch.id, { ...input, values: { a: '1', z: '2' } })
  ).toEqual(result);
  expect(() => writeChatVariables(store, chat.id, branch.id, { ...input, values: {} })).toThrow(
    'CHAT_VARIABLE_IDEMPOTENCY_CONFLICT'
  );
  expect(readChatVariables(store, chat.id, branch.id).revision).toBe(2);
});

test('CAS uses latest source edit hash and validates source chat ownership', () => {
  const { store, chat, branch } = fixture();
  const source = append(store, chat.id, branch.id);
  const input = { ...command(), expectedSourceHash: source.hash };
  const edited = store.editSource(source.id, { expectedRevision: 0, text: 'Edited source' });
  expect(() => writeChatVariables(store, chat.id, branch.id, input)).toThrow(
    'CHAT_VARIABLE_SOURCE_CONFLICT'
  );
  expect(
    writeChatVariables(store, chat.id, branch.id, { ...input, expectedSourceHash: edited.hash })
      .revision
  ).toBe(1);
  const other = createFixtureChat(store, 'Other');
  const otherSource = append(store, other.id, store.product.branch(other.id).id);
  store.db.prepare('UPDATE branches SET head_revision=? WHERE id=?').run(otherSource.id, branch.id);
  expect(() =>
    writeChatVariables(store, chat.id, branch.id, {
      ...command({}, 1),
      expectedSourceHash: otherSource.hash,
    })
  ).toThrow('CHAT_VARIABLE_SOURCE_OWNER');
});

test.each(['queued', 'running'])('new user writes reject an active %s Run', (status) => {
  const { store, chat, branch } = fixture();
  const run = reserve(store, chat.id, branch.id);
  store.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, run.id);
  expect(() => writeChatVariables(store, chat.id, branch.id, command())).toThrow(
    'CHAT_VARIABLE_BRANCH_BUSY'
  );
  expect(store.db.prepare('SELECT * FROM chat_variable_states').all()).toEqual([]);
});

test('host adoption requires a transaction and rolls state, receipt and event back together', () => {
  const { store, chat, branch } = fixture();
  const input = command();
  expect(() => writeChatVariablesInTransaction(store, chat.id, branch.id, input)).toThrow(
    'CHAT_VARIABLE_TRANSACTION_REQUIRED'
  );
  reserve(store, chat.id, branch.id);
  const beforeEvents = store.db.prepare('SELECT * FROM events').all();
  expect(() =>
    store.transaction(() => {
      writeChatVariablesInTransaction(store, chat.id, branch.id, input);
      throw new Error('Synthetic rollback');
    })
  ).toThrow('Synthetic rollback');
  expect(store.db.prepare('SELECT * FROM chat_variable_states').all()).toEqual([]);
  expect(store.db.prepare('SELECT * FROM chat_variable_journal').all()).toEqual([]);
  expect(store.db.prepare('SELECT * FROM events').all()).toEqual(beforeEvents);
  expect(
    store.transaction(() => writeChatVariablesInTransaction(store, chat.id, branch.id, input))
      .revision
  ).toBe(1);
});

test('source checkpoints preserve written overrides immutably and omit untouched branches', () => {
  const { store, chat, branch } = fixture();
  const first = append(store, chat.id, branch.id);
  store.transaction(() =>
    checkpointChatVariablesInTransaction(store, first.id, chat.id, branch.id)
  );
  expect(store.db.prepare('SELECT * FROM chat_variable_outputs').all()).toEqual([]);
  writeChatVariables(store, chat.id, branch.id, { ...command(), expectedSourceHash: first.hash });
  const second = append(store, chat.id, branch.id, 'Second source');
  store.transaction(() =>
    checkpointChatVariablesInTransaction(store, second.id, chat.id, branch.id)
  );
  const frozen = store.db.prepare('SELECT * FROM chat_variable_outputs').all();
  writeChatVariables(store, chat.id, branch.id, {
    ...command({ score: '9' }, 1),
    expectedSourceHash: second.hash,
  });
  store.transaction(() =>
    checkpointChatVariablesInTransaction(store, second.id, chat.id, branch.id)
  );
  expect(store.db.prepare('SELECT * FROM chat_variable_outputs').all()).toEqual(frozen);
  expect(JSON.parse(String(frozen[0].body))).toEqual({ revision: 1, values: { score: '0' } });
  const other = store.product.createBranch(chat.id, { title: 'Other', fromRevision: second.id });
  expect(() =>
    store.transaction(() =>
      checkpointChatVariablesInTransaction(store, second.id, chat.id, other.id)
    )
  ).toThrow('CHAT_VARIABLE_SOURCE_OWNER');
});

test('invalid maps and malformed commands leave no write receipts', () => {
  const { store, chat, branch } = fixture();
  for (const values of [
    JSON.parse('{"__proto__":"bad"}'),
    { score: 1 },
    { score: 'x'.repeat(200001) },
  ])
    expect(() => writeChatVariables(store, chat.id, branch.id, command(values))).toThrow();
  for (const change of [
    { expectedRevision: -1 },
    { expectedSourceHash: '' },
    { idempotencyKey: '' },
  ])
    expect(() =>
      writeChatVariables(store, chat.id, branch.id, { ...command(), ...change })
    ).toThrow();
  expect(store.db.prepare('SELECT * FROM chat_variable_journal').all()).toEqual([]);
});
