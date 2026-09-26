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
function source(store: Store, chatId: string, value: string, branchId?: string) {
  const chat = store.chat(chatId);
  const branch = store.product.branch(chatId, branchId);
  const profile = {
    ...store.product.snapshot(chatId),
    variableState: readChatVariables(store, chatId, branch.id),
  };
  const request = 'Synthetic source, no model request';
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: store.product.profile(chatId).revision,
      idempotencyKey: randomUUID(),
      ...(branchId ? { branchId } : {}),
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
    store.completeRun(
      run.id,
      value,
      { modelCalls: 3, inputTokens: 70, outputTokens: 90, costUsd: 0.04 },
      run.snapshot.settings
    ).id
  );
}

describe('independent stored-story fork without generation', () => {
  test('makes repeated keys durable, uses independent IDs even with identical automatic titles and rejects conflicting selections', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Names');
    const first = source(store, chat.id, 'First scene.');
    const second = source(store, chat.id, 'Second scene.');
    const body = { fromRevision: first.id, idempotencyKey: 'stable-command' };
    const a = forkChat(store, chat.id, body);
    const b = forkChat(store, chat.id, { ...body, idempotencyKey: 'second-command' });
    expect([a.title, b.title]).toEqual(['Names (사본)', 'Names (사본)']);
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
});
