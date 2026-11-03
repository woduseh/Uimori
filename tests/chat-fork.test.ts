import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { forkChat } from '../server/chat-fork.js';
import { Store } from '../server/store.js';
import type { RunSnapshot } from '../core/types.js';
import { readChatVariables } from '../server/chat-variables.js';
import { chatDeletionImpact, deleteChat } from '../server/chat-deletion.js';

const owned: { directory: string; store?: Store }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('External calls forbidden in fork tests')
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    item.store?.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('Uimori fork tests ')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori fork tests '));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
}
function source(store: Store, chatId: string, value: string) {
  const chat = store.chat(chatId);
  const profile = {
    ...store.product.snapshot(chatId),
    variableState: readChatVariables(store, chatId),
  };
  const request = 'Synthetic source, no model request';
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: store.product.profile(chatId).revision,
      idempotencyKey: randomUUID(),
    },
    (current) =>
      ({
        chatId,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request,
        history: store.history(current.headRevision),
        resources: store.product.resources(chatId, profile),
        ...(profile ? { profile } : {}),
      }) satisfies RunSnapshot
  ).run;
  store.startRun(run.id);
  return store.source(
    store.completeRun(run.id, value, {
      modelCalls: 3,
      inputTokens: 70,
      outputTokens: 90,
      costUsd: 0.04,
    }).id
  );
}

describe('independent stored-story fork without generation', () => {
  test('a matching receipt proves the copied chat was deleted without treating a different command as terminal', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Deleted copy');
    const original = source(store, chat.id, 'Original scene.');
    const command = { fromRevision: original.id, idempotencyKey: 'deleted-copy' };
    const copy = forkChat(store, chat.id, command);
    deleteChat(store, copy.id, chatDeletionImpact(store, copy.id).request);
    expect(() => forkChat(store, chat.id, command)).toThrowError(
      expect.objectContaining({ statusCode: 410, message: 'CHAT_COPY_REMOVED' })
    );
    expect(() => forkChat(store, chat.id, { ...command, fromRevision: null })).toThrowError(
      expect.objectContaining({ statusCode: 409 })
    );
    expect(store.chats()).toHaveLength(1);
  });

  test('a legacy receipt without a verified command does not claim a deleted copy is resolved', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Legacy deleted copy');
    const original = source(store, chat.id, 'Original scene.');
    const command = { fromRevision: original.id, idempotencyKey: 'legacy-deleted-copy' };
    const copy = forkChat(store, chat.id, command);
    store.db
      .prepare(
        "UPDATE import_operations SET result=json_remove(result,'$.forkCommand') WHERE key=?"
      )
      .run('transcript:copy:legacy-deleted-copy');
    deleteChat(store, copy.id, chatDeletionImpact(store, copy.id).request);
    let failure: unknown;
    try {
      forkChat(store, chat.id, command);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toMatchObject({ statusCode: 410, message: 'CHAT_COPY_REMOVED' });
    expect(store.chats()).toHaveLength(1);
  });
  test('replaying a completed copy preserves its independently changed folder and emits no new event', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Copy replay');
    const original = source(store, chat.id, 'Original scene.');
    const command = { fromRevision: original.id, idempotencyKey: 'copy-folder-replay' };
    const copy = forkChat(store, chat.id, command);
    const botId = store.organization.metadata(chat.id)!.botId;
    const folder = store.organization.createFolder(botId, { title: 'My copied stories' });
    const moved = store.organization.move(copy.id, {
      expectedRevision: copy.organizationRevision,
      folderId: folder.id,
    });
    const events = store.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE chat_id=?')
      .get(copy.id)!.n;

    expect(forkChat(store, chat.id, command)).toEqual(moved);
    expect(
      store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE chat_id=?').get(copy.id)!.n
    ).toBe(events);
  });

  test('replaying a completed copy uses the original command after the source is edited', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Edited after copy');
    const original = source(store, chat.id, 'Before editing.');
    const command = { fromRevision: original.id, idempotencyKey: 'copy-edited-replay' };
    const copy = forkChat(store, chat.id, command);
    store.editSource(original.id, { expectedRevision: 0, text: 'After editing.' });

    const replay = forkChat(store, chat.id, command);
    expect(replay.id).toBe(copy.id);
    expect(store.source(replay.headRevision!).text).toBe('Before editing.');
    expect(store.chats()).toHaveLength(2);
  });

  test('a preexisting copy receipt is recovered and upgraded using its recorded fork event', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Legacy copy');
    const original = source(store, chat.id, 'Legacy scene.');
    const command = { fromRevision: original.id, idempotencyKey: 'old-copy-receipt' };
    const copy = forkChat(store, chat.id, command);
    store.db
      .prepare(
        "UPDATE import_operations SET result=json_remove(result,'$.forkCommand') WHERE key=?"
      )
      .run('transcript:copy:old-copy-receipt');
    store.editSource(original.id, { expectedRevision: 0, text: 'Changed later.' });

    expect(forkChat(store, chat.id, command).id).toBe(copy.id);
    expect(() => forkChat(store, chat.id, { ...command, title: 'Different title' })).toThrow(
      '다른 채팅에 같은 가져오기 ID'
    );
  });

  test('numbers independent copies while repeated keys remain durable and conflicting selections are rejected', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Names');
    const first = source(store, chat.id, 'First scene.');
    const second = source(store, chat.id, 'Second scene.');
    const body = { fromRevision: first.id, idempotencyKey: 'stable-command' };
    const a = forkChat(store, chat.id, body);
    const b = forkChat(store, chat.id, { ...body, idempotencyKey: 'second-command' });
    const copied = store.history(a.headRevision);
    expect(a.id).not.toBe(chat.id);
    expect(copied.map((item) => item.text)).toEqual(['First scene.']);
    expect(copied[0]!.revision).not.toBe(first.id);
    expect(
      store.db.prepare('SELECT count(*) AS n FROM attempts WHERE chat_id=?').get(a.id)!.n
    ).toBe(0);
    expect([a.title, b.title]).toEqual(['Names (사본 1)', 'Names (사본 2)']);
    expect(forkChat(store, chat.id, body)).toEqual(a);
    expect(() => forkChat(store, chat.id, { ...body, fromRevision: second.id })).toThrow(
      '다른 채팅에 같은 가져오기 ID'
    );
    expect(() => forkChat(store, chat.id, { ...body, title: 'Different title' })).toThrow(
      '다른 채팅에 같은 가져오기 ID'
    );
    const item = owned.find((item) => item.store === store)!;
    store.close();
    item.store = undefined;
    const reopened = new Store(join(item.directory, 'story.sqlite'));
    item.store = reopened;
    expect(forkChat(reopened, chat.id, body)).toEqual(a);
    expect(reopened.chats()).toHaveLength(3);
    expect(
      forkChat(reopened, chat.id, {
        fromRevision: first.id,
        idempotencyKey: 'manual',
        title: 'Chosen title',
      }).title
    ).toBe('Chosen title');
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(['Names · 새 이야기 · 새 이야기', 'Names (사본)', 'Names · 사본 2', 'Names (사본 2)'])(
    'copying %s continues the numbered family without stacking suffixes',
    async (title) => {
      const store = await database();
      const chat = createFixtureChat(store, title);
      createFixtureChat(store, 'Names · 사본 3');
      const first = source(store, chat.id, 'First scene.');
      const copy = forkChat(store, chat.id, { fromRevision: first.id, idempotencyKey: 'copy' });
      expect(copy.title).toBe('Names (사본 4)');
      const next = forkChat(store, copy.id, {
        fromRevision: copy.headRevision,
        idempotencyKey: 'copy-again',
      });
      expect(next.title).toBe('Names (사본 5)');
      expect(store.chat(chat.id).title).toBe(title);
    }
  );
});
