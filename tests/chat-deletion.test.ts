import { writeNote } from './fixtures/notes.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import {
  chatDeletionImpact,
  deleteBranch,
  deleteChat,
  deleteSceneCommand,
} from '../server/chat-deletion.js';
import { createApp } from '../server/app.js';

const owned: { directory: string; store?: Store }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    item.store?.close();
    const target = resolve(item.directory),
      inside = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !basename(target).startsWith('Uimori deletion ')
    )
      throw new Error('Unexpected cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori deletion '));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
}
function run(store: Store, chatId: string, branchId = `main:${chatId}`, finish = true) {
  const branch = store.product.branch(chatId, branchId),
    chat = store.chat(chatId),
    profile = store.product.snapshot(chatId);
  const { run } = store.createRun(
    chatId,
    {
      request: 'Synthetic',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: crypto.randomUUID(),
      branchId,
    },
    (current) => ({
      chatId,
      parentRevision: branch.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic',
      history: store.history(branch.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    })
  );
  if (!finish) return { run, source: null };
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    'Synthetic scene.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    { ...run.snapshot.settings, translation: false, status: false }
  );
  return { run, source };
}

test('chat deletion removes owned graph atomically and preserves independent forks and catalog', async () => {
  const store = await fixture();
  const bot = store.product.content({
    kind: 'bot',
    title: 'Bot',
    description: 'Synthetic',
    text: 'Synthetic',
    loading: 'pinned',
    relatedIds: [],
  });
  const chat = createFixtureChat(store, 'Original', 'calm', { botId: bot.id });
  const first = run(store, chat.id).source!;
  run(store, chat.id);
  const fork = forkChat(store, chat.id, { fromRevision: first.id, idempotencyKey: 'fork' });
  const before = store.history(fork.headRevision);
  store.db
    .prepare('INSERT INTO source_edits VALUES(?,1,?,?,?)')
    .run(first.id, first.text, first.hash, new Date().toISOString());
  expect(deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request)).toEqual({
    deleted: true,
  });
  expect(() => store.chat(chat.id)).toThrow('Chat not found');
  expect(store.history(fork.headRevision)).toEqual(before);
  expect(store.product.get('content', bot.id)).toEqual(bot);
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  for (const table of [
    'sources',
    'runs',
    'jobs',
    'events',
    'branches',
    'chat_organization',
    'profiles',
  ])
    expect(
      store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE chat_id=?`).get(chat.id)
    ).toMatchObject({ n: 0 });
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM source_edits').get()).toMatchObject({ n: 0 });
  const restored = await fixture();
  restored.product.import(store.product.export());
  expect(restored.history(fork.headRevision)).toEqual(before);
});

test('chat confirmation rejects stale branches, settings, profile and organization with no deletion', async () => {
  const store = await fixture(),
    chat = createFixtureChat(store, 'CAS');
  const old = chatDeletionImpact(store, chat.id).request;
  store.product.createBranch(chat.id, { title: 'New', fromRevision: null });
  expect(() => deleteChat(store, chat.id, old)).toThrow('변경');
  for (const key of [
    'expectedSettingsRevision',
    'expectedProfileRevision',
    'expectedOrganizationRevision',
  ] as const) {
    const value = chatDeletionImpact(store, chat.id).request;
    value[key]++;
    expect(() => deleteChat(store, chat.id, value)).toThrow('변경');
  }
  expect(store.chats()).toHaveLength(1);
});

test('active run or outstanding provider attempt blocks deletion until completion', async () => {
  const store = await fixture(),
    chat = createFixtureChat(store, 'Busy');
  const pending = run(store, chat.id, undefined, false).run;
  expect(() => deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request)).toThrow(
    '진행 중'
  );
  store.finishRun(pending.id, 'cancelled', 'Synthetic cancellation');
  store.db
    .prepare(
      "INSERT INTO attempts(id,chat_id,run_id,role,connection_id,model_id,status,request) VALUES('attempt',?,?,'main','fixture','fixture','running','{}')"
    )
    .run(chat.id, pending.id);
  expect(() => deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request)).toThrow(
    '공급자 요청'
  );
  store.db.prepare("UPDATE attempts SET status='cancelled'").run();
  deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request);
  expect(store.chats()).toEqual([]);
});

test('exclusive branch history is deleted while shared ancestor and default snapshots are preserved', async () => {
  const store = await fixture(),
    chat = createFixtureChat(store, 'Branches');
  const ancestor = run(store, chat.id).source!;
  const branch = store.product.createBranch(chat.id, {
    title: 'Alternative',
    fromRevision: ancestor.id,
  });
  const alternative = run(store, chat.id, branch.id).source!;
  const defaultBefore = store.run(ancestor.runId);
  const current = store.product.branch(chat.id, branch.id);
  expect(() =>
    deleteBranch(store, chat.id, branch.id, { expectedRevision: current.revision + 1 })
  ).toThrow('변경');
  expect(() =>
    deleteBranch(store, chat.id, `main:${chat.id}`, {
      expectedRevision: store.product.branch(chat.id).revision,
    })
  ).toThrow('기본 분기');
  deleteBranch(store, chat.id, branch.id, { expectedRevision: current.revision });
  expect(() => store.source(alternative.id)).toThrow();
  expect(store.run(ancestor.runId)).toEqual(defaultBefore);
  expect(store.product.branches(chat.id)).toHaveLength(1);
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const restored = await fixture();
  restored.product.import(store.product.export());
  expect(restored.source(ancestor.id)).toMatchObject(ancestor);
});

test('unused author canon and scene commands can be deleted; referenced and retcon entries remain', async () => {
  const store = await fixture(),
    chat = createFixtureChat(store, 'Story');
  const first = writeNote(store, chat.id, {
    text: 'Synthetic unused canon',
    author: 'Author',
  });
  writeNote(store, chat.id, { text: '', author: 'Author', retired: true }, first.id);
  expect(store.story.detail(chat.id).notes).toEqual([]);
  const prior = writeNote(store, chat.id, { text: 'Old canon', author: 'Author' });
  const replacement = writeNote(store, chat.id, { text: 'New canon', author: 'Author' }, prior.id);
  expect(store.story.detail(chat.id).notes).toContainEqual(replacement);
  const command = store.story.createCommand(chat.id, {
    label: 'Scene',
    request: 'Synthetic request',
    idempotencyKey: 'scene',
  });
  expect(deleteSceneCommand(store, command.id, {}).deleted).toBe(true);
  expect(store.story.commands(chat.id, `main:${chat.id}`)).toEqual([]);
  const canon = writeNote(store, chat.id, { text: 'Used canon', author: 'Author' });
  run(store, chat.id);
  writeNote(store, chat.id, { text: '', author: 'Author', retired: true }, canon.id);
  expect(store.story.detail(chat.id).notes).not.toContainEqual(canon);
  const restored = await fixture();
  restored.product.import(store.product.export());
  expect(restored.story.detail(chat.id).notes).toEqual(store.story.detail(chat.id).notes);
});

test('deleting a branch preserves shared configuration and removes its package receipts', async () => {
  const store = await fixture(),
    chat = createFixtureChat(store, 'Package cleanup'),
    main = `main:${chat.id}`;
  const before = store.story.configForBranch(chat.id, main),
    branch = store.product.createBranch(chat.id, { title: 'Branch', fromRevision: null });
  run(store, chat.id, branch.id);
  deleteBranch(store, chat.id, branch.id, {
    expectedRevision: store.product.branch(chat.id, branch.id).revision,
  });
  expect(store.story.configForBranch(chat.id, main)).toEqual(before);
  expect(
    store.db
      .prepare('SELECT COUNT(*) AS n FROM package_requests WHERE chat_id=? AND branch_id=?')
      .get(chat.id, branch.id)
  ).toMatchObject({ n: 0 });
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const restored = await fixture();
  restored.product.import(store.product.export());
  expect(restored.story.configForBranch(chat.id, main)).toEqual(before);
});

test('branch with an active global story configuration anchor is retained', async () => {
  const store = await fixture(),
    chat = createFixtureChat(store, 'Global config'),
    branch = store.product.createBranch(chat.id, { title: 'Config origin', fromRevision: null });
  run(store, chat.id, branch.id);
  store.story.saveConfig(chat.id, {
    branchId: branch.id,
    expectedRevision: 0,
    module: {
      id: 'count',
      revision: 1,
      name: 'Count',
      mode: 'continuity',
      fields: { count: { type: 'number', initial: 0, min: 0, max: 10 } },
      rules: {},
    },
    stateModel: null,
  });
  expect(() =>
    deleteBranch(store, chat.id, branch.id, {
      expectedRevision: store.product.branch(chat.id, branch.id).revision,
    })
  ).toThrow('다른 분기');
  const restored = await fixture();
  restored.product.import(store.product.export());
  expect(restored.product.branch(chat.id, branch.id)).toEqual(
    store.product.branch(chat.id, branch.id)
  );
});

test('HTTP deletion impact and delete routes return errors before mutation and success after commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori deletion '));
  owned.push({ directory });
  const app = await createApp({
    dbPath: join(directory, 'http.sqlite'),
    buildId: 'deletion-fixture',
    testMode: true,
  });
  try {
    const chat = createFixtureChat(app.store, 'HTTP');
    const branch = app.store.product.createBranch(chat.id, {
      title: 'Alternative',
      fromRevision: null,
    });
    const stale = (
      await injectWithFixtureBot(app, {
        method: 'GET',
        url: `/api/chats/${chat.id}/deletion-impact`,
      })
    ).json().request;
    expect(
      (
        await injectWithFixtureBot(app, {
          method: 'DELETE',
          url: `/api/chats/${chat.id}/branches/${branch.id}`,
          payload: { expectedRevision: 2 },
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await injectWithFixtureBot(app, {
          method: 'DELETE',
          url: `/api/chats/${chat.id}/branches/${branch.id}`,
          payload: { expectedRevision: 1 },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await injectWithFixtureBot(app, {
          method: 'DELETE',
          url: `/api/chats/${chat.id}`,
          payload: stale,
        })
      ).statusCode
    ).toBe(409);
    const canon = writeNote(app.store, chat.id, {
      text: 'Unused canon',
      author: 'Author',
    });
    expect(
      (
        await injectWithFixtureBot(app, {
          method: 'POST',
          url: `/api/chats/${chat.id}/notes`,
          payload: {
            text: '',
            author: 'Author',
            retired: true,
            replacesId: canon.id,
            expectedRevision: app.store.story.notes.revision(chat.id),
            expectedHeadRevision: app.store.chat(chat.id).headRevision,
            idempotencyKey: 'retire-note',
          },
        })
      ).statusCode
    ).toBe(200);
    const command = app.store.story.createCommand(chat.id, {
      label: 'Unused',
      request: 'Unused',
      idempotencyKey: 'unused',
    });
    expect(
      (
        await injectWithFixtureBot(app, {
          method: 'DELETE',
          url: `/api/scene-commands/${command.id}`,
          payload: {},
        })
      ).statusCode
    ).toBe(200);
    const impact = await injectWithFixtureBot(app, {
      method: 'GET',
      url: `/api/chats/${chat.id}/deletion-impact`,
    });
    expect(impact.statusCode).toBe(200);
    const deleted = await injectWithFixtureBot(app, {
      method: 'DELETE',
      url: `/api/chats/${chat.id}`,
      payload: impact.json().request,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true });
    expect(
      (
        await injectWithFixtureBot(app, {
          method: 'GET',
          url: `/api/chats/${chat.id}/deletion-impact`,
        })
      ).statusCode
    ).toBe(404);
  } finally {
    await app.close();
  }
});

test('dependent branch prevents parent deletion and deleting child first makes it possible', async () => {
  const store = await fixture(),
    chat = createFixtureChat(store, 'Dependencies');
  const branch = store.product.createBranch(chat.id, { title: 'Parent', fromRevision: null });
  const source = run(store, chat.id, branch.id).source!;
  const child = store.product.createBranch(chat.id, { title: 'Child', fromRevision: source.id });
  run(store, chat.id, child.id);
  const request = { expectedRevision: store.product.branch(chat.id, branch.id).revision };
  expect(() => deleteBranch(store, chat.id, branch.id, request)).toThrow('다른 분기');
  deleteBranch(store, chat.id, child.id, {
    expectedRevision: store.product.branch(chat.id, child.id).revision,
  });
  deleteBranch(store, chat.id, branch.id, request);
  expect(store.product.branches(chat.id)).toHaveLength(1);
});
