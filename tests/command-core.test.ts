import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod/v4';
import { chatSettingsEndpoints, type Endpoint, endpointRequest } from '#contracts';
import { chatSettingsOperations, defineCommandOperation, nonBlank } from '#contracts/operations';
import { createApp, type App } from '../server/app.js';
import { AppError, assertRevision } from '../server/app-errors.js';
import { deleteChat } from '../server/chat-deletion.js';
import { readChatVariables, saveChatVariableState } from '../server/chat-variables.js';
import { type Command, defineCommand, executeOperation } from '../server/command.js';
import {
  allCommands,
  updateChatVariablesCommand,
  updateStoryGuideCommand,
} from '../server/commands/index.js';
import { helperChatStateCommand } from '../server/helper-chat-state-tools.js';
import { defineHelperCommandTool, executeHelperCommand } from '../server/helper-command-adapter.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { type AppPorts, createStorePorts } from '../server/store-ports.js';
import { Store } from '../server/store.js';
import type { Tx } from '../server/tx.js';
import { createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import {
  helperCall,
  helperDone,
  runScriptedChatHelper,
  selectFixtureModels,
} from './fixtures/scripted-helper.js';

const owned: { close: () => Promise<void> | void; directory: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    await item.close();
    const within = relative(resolve(tmpdir()), resolve(item.directory));
    if (isAbsolute(within) || within.startsWith('..') || !within.startsWith('uimori-command-core-'))
      throw new Error('Unsafe cleanup');
    rmSync(item.directory, { recursive: true, force: true });
  }
});

function createStoreFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-command-core-'));
  const store = new Store(join(directory, 'app.sqlite'));
  owned.push({ close: () => store.close(), directory });
  return store;
}

async function createAppFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-command-core-'));
  const app: App = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'command-core-test',
    testMode: true,
    codex: { enabled: false },
  });
  owned.push({ close: () => app.close(), directory });
  selectFixtureModels(app.store);
  return app;
}

function reserveRun(store: Store, chatId: string) {
  const chat = store.chat(chatId);
  return store.createRun(
    chatId,
    {
      request: 'Synthetic run',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      request: 'Synthetic run',
      parentRevision: chat.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      history: store.history(chat.headRevision),
      resources: [],
    })
  ).run;
}

type CommandProbe = {
  readonly command: Command<any, any>;
  readonly endpoint: Endpoint<any>;
  readonly arrange: (store: Store) => {
    readonly deletedWithBrokenBody: Record<string, unknown>;
    readonly staleWithBrokenBody: Record<string, unknown>;
    readonly valid: Record<string, unknown>;
    readonly receipt?: {
      readonly first: Record<string, unknown>;
      readonly reordered: Record<string, unknown>;
      readonly conflicting: Record<string, unknown>;
      readonly mutateGuardState: (store: Store) => void;
    };
  };
};

const commandProbes: Record<keyof typeof allCommands, CommandProbe> = {
  'chat-settings.writeVariables': {
    command: updateChatVariablesCommand,
    endpoint: chatSettingsEndpoints.writeVariables,
    arrange(store) {
      const gone = createFixtureChat(store, 'Deleted variables chat');
      deleteChat(store, gone.id);
      const live = createFixtureChat(store, 'Live variables chat');
      const source = completedSource(store, live.id, 'First scene');
      const receiptChat = createFixtureChat(store, 'Receipt variables chat');
      const receiptKey = randomUUID();
      return {
        deletedWithBrokenBody: {
          chatId: gone.id,
          expectedRevision: 0,
          expectedSourceHash: null,
          idempotencyKey: randomUUID(),
          values: 'not-an-object',
          unknownField: 123,
        },
        staleWithBrokenBody: {
          chatId: live.id,
          expectedRevision: 9,
          expectedSourceHash: source.hash,
          idempotencyKey: randomUUID(),
          set: {},
          unknownField: 123,
        },
        valid: {
          chatId: live.id,
          expectedRevision: 0,
          expectedSourceHash: source.hash,
          idempotencyKey: randomUUID(),
          set: { mood: 'steady' },
        },
        receipt: {
          first: {
            chatId: receiptChat.id,
            expectedRevision: 0,
            expectedSourceHash: null,
            idempotencyKey: receiptKey,
            values: { z: 'last', a: 'first' },
          },
          reordered: {
            chatId: receiptChat.id,
            expectedRevision: 0,
            expectedSourceHash: null,
            idempotencyKey: receiptKey,
            values: { a: 'first', z: 'last' },
          },
          conflicting: {
            chatId: receiptChat.id,
            expectedRevision: 0,
            expectedSourceHash: null,
            idempotencyKey: receiptKey,
            values: 'different-and-broken',
          },
          mutateGuardState(currentStore) {
            const ports = createStorePorts(currentStore);
            ports.tx.transaction((tx) => {
              ports.chatVariables.save(tx, receiptChat.id, {
                revision: 2,
                values: { a: 'updated-later' },
              });
            });
            completedSource(currentStore, receiptChat.id, 'New scene after receipt');
            reserveRun(currentStore, receiptChat.id);
          },
        },
      };
    },
  },
  'chat-settings.updateStoryGuide': {
    command: updateStoryGuideCommand,
    endpoint: chatSettingsEndpoints.updateStoryGuide,
    arrange(store) {
      const gone = createFixtureChat(store, 'Deleted guide chat');
      deleteChat(store, gone.id);
      const live = createFixtureChat(store, 'Live guide chat');
      return {
        deletedWithBrokenBody: {
          chatId: gone.id,
          expectedRevision: 0,
          config: { enabled: 'not-a-boolean' },
          unknownField: true,
        },
        staleWithBrokenBody: {
          chatId: live.id,
          expectedRevision: 4,
          changes: {},
          unknownField: true,
        },
        valid: {
          chatId: live.id,
          expectedRevision: 0,
          changes: { enabled: true, work: 'Harbor Chronicle' },
        },
      };
    },
  },
};

test('every registered command in allCommands has a probe entry', () => {
  expect(Object.keys(commandProbes).sort()).toEqual(Object.keys(allCommands).sort());
});

test.each(Object.entries(commandProbes))(
  '%s answers 409 REVISION_CONFLICT on deleted or stale targets even with a broken body',
  async (_name, probe) => {
    const store = createStoreFixture();
    const publish = vi.fn();
    const ports = createStorePorts(store, { publish });
    const cases = probe.arrange(store);
    await expect(
      executeOperation(probe.command, ports, cases.deletedWithBrokenBody)
    ).rejects.toMatchObject({ statusCode: 409, code: 'REVISION_CONFLICT' });
    await expect(
      executeOperation(probe.command, ports, cases.staleWithBrokenBody)
    ).rejects.toMatchObject({ statusCode: 409, code: 'REVISION_CONFLICT' });
    expect(publish).not.toHaveBeenCalled();

    const ok = await executeOperation(probe.command, ports, cases.valid);
    expect(ok).toBeDefined();
    expect(publish).toHaveBeenCalledTimes(1);
  }
);

test.each(Object.entries(commandProbes).filter(([, probe]) => probe.command.receipt !== undefined))(
  '%s replays an existing receipt after guard state changes and refuses a different body with 409',
  async (_name, probe) => {
    const store = createStoreFixture();
    const publish = vi.fn();
    const ports = createStorePorts(store, { publish });
    const receipt = probe.arrange(store).receipt!;
    const first = await executeOperation(probe.command, ports, receipt.first);
    expect(publish).toHaveBeenCalledTimes(1);

    receipt.mutateGuardState(store);

    const replayed = await executeOperation(probe.command, ports, receipt.reordered);
    expect(replayed).toMatchObject({
      revision: 2,
      values: { a: 'updated-later' },
      pending: true,
    });
    expect(replayed).not.toEqual(first);
    expect(publish).toHaveBeenCalledTimes(1);

    await expect(executeOperation(probe.command, ports, receipt.conflicting)).rejects.toMatchObject(
      {
        statusCode: 409,
      }
    );
  }
);

test('prepare-bearing receipt commands run prepare once and preserve helper results on replay', async () => {
  const store = createStoreFixture();
  const model = selectFixtureModels(store);
  const chat = createFixtureChat(store, 'Prepare receipt chat');
  const workspace = new HelperWorkspace(store);
  const conversation = workspace.open({ kind: 'chat', chatId: chat.id });
  const task = workspace.enqueue(conversation.id, randomUUID(), 'Prepare update', {
    scope: { kind: 'chat', chatId: chat.id },
    model: store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    limits: { totalCalls: 4, helperCalls: 4 },
  });
  workspace.start(task.id, 'owner-1');
  const ports = createStorePorts(store);

  const bodySchema = z.strictObject({ label: nonBlank(50) });
  const op = defineCommandOperation<{ revision: number; values: Record<string, string> }>()({
    name: 'test.prepareReceipt',
    head: z.strictObject({
      chatId: nonBlank(120),
      idempotencyKey: nonBlank(120),
      expectedRevision: z.int().nonnegative(),
    }),
    body: bodySchema,
  });
  const prepare = vi.fn(async (_ports, _head, raw: Record<string, unknown>) => ({
    preparedLabel: String(raw.label).toUpperCase(),
  }));
  const afterCommit = vi.fn();
  const command = defineCommand<Pick<AppPorts, 'tx' | 'receipt' | 'chatGuard' | 'chatVariables'>>()(
    op,
    {
      receipt: {
        scope: (head) => head.chatId,
        key: (head) => head.idempotencyKey,
        serialize: (output) => ({ revision: output.revision }),
        onReplay: (_tx, replayPorts, _record, head) => {
          const state = replayPorts.chatVariables.read(head.chatId);
          return { revision: state.revision, values: state.values };
        },
      },
      prepare,
      guard(tx, guardPorts, head) {
        guardPorts.chatGuard.writableChat(tx, head.chatId);
        const current = guardPorts.chatVariables.read(head.chatId);
        assertRevision(current.revision, head.expectedRevision);
        return { current };
      },
      apply(tx, applyPorts, input, guarded, prepared) {
        const saved = applyPorts.chatVariables.save(tx, input.chatId, {
          revision: guarded.current.revision + 1,
          values: { ...guarded.current.values, prepared: prepared.preparedLabel },
        });
        return { revision: saved.revision, values: saved.values };
      },
      afterCommit,
    }
  );

  const makeTool = (injectIdempotencyKey: boolean) =>
    defineHelperCommandTool({
      name: 'test.prepare.update',
      description: 'Test prepare command',
      command,
      schemaBody: bodySchema,
      omitHeadKeys: injectIdempotencyKey ? ['chatId', 'idempotencyKey'] : ['chatId'],
      injectIdempotencyKey,
      formatResult(outcome, { chatId, receiptId, chatTitle }) {
        return {
          toolOutput: {
            changed: !outcome.replayed,
            revision: outcome.output.revision,
            value: outcome.output.values.prepared ?? null,
          },
          taskResult: {
            receiptId,
            operation: 'test.prepare.update',
            requestedTargets: 1,
            targets: !outcome.replayed
              ? [
                  {
                    kind: 'settings',
                    id: chatId,
                    title: chatTitle,
                    revision: outcome.output.revision,
                    setting: 'chat.variables',
                  },
                ]
              : [],
          },
        };
      },
    });

  const injectedTool = makeTool(true);
  const receiptId = `${task.id}:prepare-1`;
  const first = await executeHelperCommand(
    injectedTool,
    { store, workspace },
    task,
    receiptId,
    chat.id,
    { expectedRevision: 0, label: 'alpha' }
  );
  expect(first).toEqual({ changed: true, revision: 1, value: 'ALPHA' });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(afterCommit).toHaveBeenCalledTimes(1);

  ports.tx.transaction((tx) => {
    ports.chatVariables.save(tx, chat.id, { revision: 2, values: { prepared: 'LATER' } });
  });

  const replayedHelper = await executeHelperCommand(
    injectedTool,
    { store, workspace },
    task,
    receiptId,
    chat.id,
    { expectedRevision: 0, label: 'alpha' }
  );
  expect(replayedHelper).toEqual(first);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(afterCommit).toHaveBeenCalledTimes(1);

  const explicitTool = makeTool(false);
  const sharedKey = `explicit:${randomUUID()}`;
  const firstExplicit = await executeHelperCommand(
    explicitTool,
    { store, workspace },
    task,
    `${task.id}:prepare-explicit-1`,
    chat.id,
    { idempotencyKey: sharedKey, expectedRevision: 2, label: 'beta' }
  );
  expect(firstExplicit).toEqual({ changed: true, revision: 3, value: 'BETA' });
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(afterCommit).toHaveBeenCalledTimes(2);

  const replayedAcrossReceiptId = await executeHelperCommand(
    explicitTool,
    { store, workspace },
    task,
    `${task.id}:prepare-explicit-2`,
    chat.id,
    { idempotencyKey: sharedKey, expectedRevision: 2, label: 'beta' }
  );
  expect(replayedAcrossReceiptId).toEqual({ changed: false, revision: 3, value: 'BETA' });
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(afterCommit).toHaveBeenCalledTimes(2);

  const aroundTxSpy = vi.fn();
  const onInTx = vi.fn();
  const replayedDirect = await executeOperation(
    command,
    ports,
    { chatId: chat.id, idempotencyKey: sharedKey, expectedRevision: 2, label: 'beta' },
    {
      aroundTx: (run) => {
        aroundTxSpy();
        return run();
      },
      onInTx,
    }
  );
  expect(replayedDirect).toEqual({ revision: 3, values: { prepared: 'BETA' } });
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(aroundTxSpy).toHaveBeenCalledTimes(1);
  expect(onInTx).toHaveBeenCalledTimes(1);
  expect(onInTx).toHaveBeenCalledWith(expect.anything(), {
    replayed: true,
    output: { revision: 3, values: { prepared: 'BETA' } },
  });
  expect(afterCommit).toHaveBeenCalledTimes(2);

  await expect(
    executeOperation(
      command,
      ports,
      { chatId: chat.id, idempotencyKey: sharedKey, expectedRevision: 2, label: 'gamma' },
      {
        aroundTx: (run) => {
          aroundTxSpy();
          return run();
        },
        onInTx,
      }
    )
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(prepare).toHaveBeenCalledTimes(2);
});

test('HTTP and helper produce the same stored state and error codes for chat.variables.update', async () => {
  const app = await createAppFixture();
  const httpChat = createFixtureChat(app.store, 'HTTP variables');
  const helperChat = createFixtureChat(app.store, 'Helper variables');
  const httpSource = completedSource(app.store, httpChat.id, 'Same opening');
  const helperSource = completedSource(app.store, helperChat.id, 'Same opening');

  const seed = async (chatId: string, sourceHash: string) =>
    executeOperation(updateChatVariablesCommand, createStorePorts(app.store), {
      chatId,
      expectedRevision: 0,
      expectedSourceHash: sourceHash,
      idempotencyKey: randomUUID(),
      values: { mood: 'tense', quest: 'started' },
    });
  await seed(httpChat.id, httpSource.hash);
  await seed(helperChat.id, helperSource.hash);

  const patch = { set: { score: '5' }, unset: ['mood'] };
  const httpOk = await app.inject({
    method: 'PUT',
    url: `/api${endpointRequest(chatSettingsEndpoints.writeVariables, { chatId: httpChat.id }).path}`,
    payload: {
      expectedRevision: 1,
      expectedSourceHash: httpSource.hash,
      idempotencyKey: randomUUID(),
      ...patch,
    },
  });
  expect(httpOk.statusCode, httpOk.body).toBe(200);

  const chatChanged = vi.fn();
  const helperRun = await runScriptedChatHelper(
    app.store,
    helperChat.id,
    [
      helperCall('merge', 'chat.variables.update', {
        expectedRevision: 1,
        expectedSourceHash: helperSource.hash,
        ...patch,
      }),
      helperCall('same', 'chat.variables.update', {
        expectedRevision: 2,
        expectedSourceHash: helperSource.hash,
        set: { score: '5' },
      }),
      helperDone,
    ],
    { chatChanged }
  );

  expect(helperRun.finished('merge')).toMatchObject({ denied: false });
  expect(helperRun.finished('same')).toMatchObject({ denied: false });
  expect(readChatVariables(app.store, httpChat.id)).toEqual(
    readChatVariables(app.store, helperChat.id)
  );
  expect(readChatVariables(app.store, helperChat.id)).toEqual({
    revision: 2,
    values: { quest: 'started', score: '5' },
  });
  expect(chatChanged).toHaveBeenCalledTimes(1);
  expect(chatChanged).toHaveBeenCalledWith(helperChat.id);
  expect(helperRun.results.map((item) => [item.operation, item.changedTargets])).toEqual([
    ['chat.variables.update', 1],
    ['chat.variables.update', 0],
  ]);
  expect(helperRun.results[0]!.targets).toEqual([
    {
      kind: 'settings',
      id: helperChat.id,
      title: helperChat.title,
      revision: 2,
      setting: 'chat.variables',
    },
  ]);

  const errorCases: Array<{
    name: string;
    body: (sourceHash: string) => Record<string, unknown>;
    expectedCode: string;
  }> = [
    {
      name: 'stale-revision-unchanged',
      body: (sourceHash) => ({
        expectedRevision: 1,
        expectedSourceHash: sourceHash,
        set: { score: '5' },
      }),
      expectedCode: 'REVISION_CONFLICT',
    },
    {
      name: 'stale-source-broken-body',
      body: () => ({
        expectedRevision: 2,
        expectedSourceHash: 'a'.repeat(64),
        set: {},
      }),
      expectedCode: 'REVISION_CONFLICT',
    },
    {
      name: 'empty-patch',
      body: (sourceHash) => ({ expectedRevision: 2, expectedSourceHash: sourceHash }),
      expectedCode: 'INVALID_REQUEST',
    },
    {
      name: 'unsafe-set',
      body: (sourceHash) => ({
        expectedRevision: 2,
        expectedSourceHash: sourceHash,
        set: { constructor: 'x', prototype: 'y', score: '6' },
      }),
      expectedCode: 'INVALID_REQUEST',
    },
    {
      name: 'unsafe-unset',
      body: (sourceHash) => ({
        expectedRevision: 2,
        expectedSourceHash: sourceHash,
        unset: ['__proto__', 'constructor', 'prototype'],
      }),
      expectedCode: 'INVALID_REQUEST',
    },
    {
      name: 'overlap-set-unset',
      body: (sourceHash) => ({
        expectedRevision: 2,
        expectedSourceHash: sourceHash,
        set: { score: '6' },
        unset: ['score'],
      }),
      expectedCode: 'INVALID_REQUEST',
    },
    {
      name: 'unknown-field',
      body: (sourceHash) => ({
        expectedRevision: 2,
        expectedSourceHash: sourceHash,
        set: { score: '6' },
        note: 'extra',
      }),
      expectedCode: 'INVALID_REQUEST',
    },
  ];

  const helperErrors = await runScriptedChatHelper(app.store, helperChat.id, [
    ...errorCases.map((entry) =>
      helperCall(entry.name, 'chat.variables.update', entry.body(helperSource.hash) as never)
    ),
    helperCall('unsafe-proto-set', 'chat.variables.update', {
      expectedRevision: 2,
      expectedSourceHash: helperSource.hash,
      set: JSON.parse('{"__proto__":"x","score":"6"}'),
    }),
    helperCall('spoof-idempotency', 'chat.variables.update', {
      expectedRevision: 2,
      expectedSourceHash: helperSource.hash,
      idempotencyKey: 'model-supplied',
      set: { score: '6' },
    }),
    helperDone,
  ]);
  for (const entry of errorCases) {
    const httpRes = await app.inject({
      method: 'PUT',
      url: `/api/chats/${httpChat.id}/variables`,
      payload: { idempotencyKey: randomUUID(), ...entry.body(httpSource.hash) },
    });
    expect(httpRes.json(), `HTTP ${entry.name}`).toEqual({ code: entry.expectedCode });
    expect(helperErrors.finished(entry.name), `Helper ${entry.name}`).toMatchObject({
      denied: true,
      errorCode: entry.expectedCode,
    });
  }
  const httpProto = await app.inject({
    method: 'PUT',
    url: `/api/chats/${httpChat.id}/variables`,
    payload: {
      expectedRevision: 2,
      expectedSourceHash: httpSource.hash,
      idempotencyKey: randomUUID(),
      set: JSON.parse('{"__proto__":"x","score":"6"}'),
    },
  });
  expect(httpProto.statusCode).toBe(400);
  expect(helperErrors.finished('unsafe-proto-set')).toMatchObject({
    denied: true,
    errorCode: 'INVALID_REQUEST',
  });
  await expect(
    executeOperation(updateChatVariablesCommand, createStorePorts(app.store), {
      chatId: httpChat.id,
      expectedRevision: 2,
      expectedSourceHash: httpSource.hash,
      idempotencyKey: randomUUID(),
      set: JSON.parse('{"__proto__":"x","score":"6"}'),
    })
  ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' });
  expect(helperErrors.finished('spoof-idempotency')).toMatchObject({
    denied: true,
    errorCode: 'INVALID_REQUEST',
  });
  expect(readChatVariables(app.store, httpChat.id)).toEqual(
    readChatVariables(app.store, helperChat.id)
  );
});

test('HTTP and helper produce the same stored state and error codes for chat.guide.update', async () => {
  const app = await createAppFixture();
  const httpChat = createFixtureChat(app.store, 'HTTP guide');
  const helperChat = createFixtureChat(app.store, 'Helper guide');

  const patch = { changes: { enabled: true, work: '항구 연대기 1권' } };
  const httpOk = await app.inject({
    method: 'PUT',
    url: `/api/chats/${httpChat.id}/story-guide`,
    payload: { expectedRevision: 0, ...patch },
  });
  expect(httpOk.statusCode, httpOk.body).toBe(200);

  const helperRun = await runScriptedChatHelper(app.store, helperChat.id, [
    helperCall('guide', 'chat.guide.update', { expectedRevision: 0, ...patch }),
    helperDone,
  ]);
  expect(helperRun.finished('guide')).toMatchObject({ denied: false });
  expect(app.store.storyGuide.get(httpChat.id)).toEqual(app.store.storyGuide.get(helperChat.id));
  expect(app.store.storyGuide.get(helperChat.id)).toMatchObject({
    revision: 1,
    config: { enabled: true, work: '항구 연대기 1권' },
  });
  expect(helperRun.results.map((item) => [item.operation, item.changedTargets])).toEqual([
    ['chat.guide.update', 1],
  ]);

  const errorCases: Array<{
    name: string;
    payload: Record<string, unknown>;
    expectedCode: string;
  }> = [
    {
      name: 'stale-broken',
      payload: { expectedRevision: 0, changes: { work: 'x'.repeat(600) } },
      expectedCode: 'REVISION_CONFLICT',
    },
    {
      name: 'empty',
      payload: { expectedRevision: 1, changes: {} },
      expectedCode: 'INVALID_REQUEST',
    },
    {
      name: 'unknown-setting',
      payload: { expectedRevision: 1, changes: { unknown: true } },
      expectedCode: 'INVALID_REQUEST',
    },
    {
      name: 'unknown-field',
      payload: { expectedRevision: 1, changes: { enabled: false }, note: 'x' },
      expectedCode: 'INVALID_REQUEST',
    },
    {
      name: 'too-long',
      payload: { expectedRevision: 1, changes: { work: 'x'.repeat(600) } },
      expectedCode: 'INVALID_REQUEST',
    },
  ];

  const helperErrors = await runScriptedChatHelper(app.store, helperChat.id, [
    ...errorCases.map((entry) =>
      helperCall(entry.name, 'chat.guide.update', entry.payload as never)
    ),
    helperDone,
  ]);
  for (const entry of errorCases) {
    const httpRes = await app.inject({
      method: 'PUT',
      url: `/api/chats/${httpChat.id}/story-guide`,
      payload: entry.payload,
    });
    expect(httpRes.json(), `HTTP ${entry.name}`).toEqual({ code: entry.expectedCode });
    expect(helperErrors.finished(entry.name), `Helper ${entry.name}`).toMatchObject({
      denied: true,
      errorCode: entry.expectedCode,
    });
  }
  expect(app.store.storyGuide.get(httpChat.id)).toEqual(app.store.storyGuide.get(helperChat.id));
});

test('helper tools refuse full-replacement inputs while preserving stored state and 409-before-400 order', async () => {
  const app = await createAppFixture();
  const chat = createFixtureChat(app.store, 'Helper narrowed body chat');
  const source = completedSource(app.store, chat.id, 'Opening scene');
  const ports = createStorePorts(app.store);

  await executeOperation(updateChatVariablesCommand, ports, {
    chatId: chat.id,
    expectedRevision: 0,
    expectedSourceHash: source.hash,
    idempotencyKey: randomUUID(),
    set: { authored: 'keep' },
  });
  await executeOperation(updateStoryGuideCommand, ports, {
    chatId: chat.id,
    expectedRevision: 0,
    changes: { enabled: true, work: 'Keep Chronicle' },
  });

  const helperRun = await runScriptedChatHelper(app.store, chat.id, [
    helperCall('replace-vars', 'chat.variables.update', {
      expectedRevision: 1,
      expectedSourceHash: source.hash,
      values: {},
    }),
    helperCall('stale-replace-vars', 'chat.variables.update', {
      expectedRevision: 0,
      expectedSourceHash: source.hash,
      values: {},
    }),
    helperCall('replace-guide', 'chat.guide.update', {
      expectedRevision: 1,
      config: {
        enabled: false,
        work: '',
        reference: '',
        position: '',
        followCanon: false,
        webSearch: false,
      },
    }),
    helperCall('stale-replace-guide', 'chat.guide.update', {
      expectedRevision: 0,
      config: {
        enabled: false,
        work: '',
        reference: '',
        position: '',
        followCanon: false,
        webSearch: false,
      },
    }),
    helperDone,
  ]);

  expect(helperRun.finished('replace-vars')).toMatchObject({
    denied: true,
    errorCode: 'INVALID_REQUEST',
  });
  expect(helperRun.finished('stale-replace-vars')).toMatchObject({
    denied: true,
    errorCode: 'REVISION_CONFLICT',
  });
  expect(helperRun.finished('replace-guide')).toMatchObject({
    denied: true,
    errorCode: 'INVALID_REQUEST',
  });
  expect(helperRun.finished('stale-replace-guide')).toMatchObject({
    denied: true,
    errorCode: 'REVISION_CONFLICT',
  });
  expect(readChatVariables(app.store, chat.id)).toEqual({
    revision: 1,
    values: { authored: 'keep' },
  });
  expect(app.store.storyGuide.get(chat.id)).toMatchObject({
    revision: 1,
    config: { enabled: true, work: 'Keep Chronicle' },
  });
});

test('helper command writes domain state, change card and receipt in one transaction and rolls all back on failure', async () => {
  const store = createStoreFixture();
  const model = selectFixtureModels(store);
  const chat = createFixtureChat(store, 'Atomic helper chat');
  const workspace = new HelperWorkspace(store);
  const conversation = workspace.open({ kind: 'chat', chatId: chat.id });
  const task = workspace.enqueue(conversation.id, randomUUID(), 'Update guide', {
    scope: { kind: 'chat', chatId: chat.id },
    model: store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    limits: { totalCalls: 4, helperCalls: 4 },
  });
  workspace.start(task.id, 'owner-1');
  const tool = helperChatStateCommand('chat.guide.update')!;
  const chatChanged = vi.fn();

  vi.spyOn(workspace, 'event').mockImplementationOnce(() => {
    throw new Error('Injected helper change record failure');
  });
  await expect(
    executeHelperCommand(
      tool,
      { store, workspace, chatChanged },
      task,
      `${task.id}:atomic-fail`,
      chat.id,
      { expectedRevision: 0, changes: { enabled: true, work: 'Must roll back' } }
    )
  ).rejects.toThrow('Injected helper change record failure');

  expect(store.storyGuide.get(chat.id).revision).toBe(0);
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_changes WHERE task_id=?').get(task.id)
  ).toEqual({ n: 0 });
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
  ).toEqual({ n: 0 });
  expect(chatChanged).not.toHaveBeenCalled();

  const saved = await executeHelperCommand(
    tool,
    { store, workspace, chatChanged },
    task,
    `${task.id}:atomic-ok`,
    chat.id,
    { expectedRevision: 0, changes: { enabled: true, work: 'Committed together' } }
  );
  expect(saved).toMatchObject({ changed: true, revision: 1 });
  expect(store.storyGuide.get(chat.id).revision).toBe(1);
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_changes WHERE task_id=?').get(task.id)
  ).toEqual({ n: 1 });
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
  ).toEqual({ n: 1 });
  expect(chatChanged).toHaveBeenCalledTimes(1);

  const replayed = await executeHelperCommand(
    tool,
    { store, workspace, chatChanged },
    task,
    `${task.id}:atomic-ok`,
    chat.id,
    { expectedRevision: 0, changes: { enabled: true, work: 'Committed together' } }
  );
  expect(replayed).toEqual(saved);
  expect(chatChanged).toHaveBeenCalledTimes(1);
});

test('helper commands answer 409 REVISION_CONFLICT on a deleted chat even with a broken body', async () => {
  const store = createStoreFixture();
  const model = selectFixtureModels(store);
  const chat = createFixtureChat(store, 'Deleted helper chat');
  const workspace = new HelperWorkspace(store);
  const conversation = workspace.open({ kind: 'library', workId: 'deleted-chat-check' });
  const task = workspace.enqueue(conversation.id, randomUUID(), 'Update deleted chat', {
    scope: { kind: 'library', workId: 'deleted-chat-check' },
    model: store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    limits: { totalCalls: 4, helperCalls: 4 },
  });
  workspace.start(task.id, 'owner-1');
  deleteChat(store, chat.id);

  await expect(
    executeHelperCommand(
      helperChatStateCommand('chat.variables.update')!,
      { store, workspace },
      task,
      `${task.id}:vars-deleted`,
      chat.id,
      { expectedRevision: 0, expectedSourceHash: null, set: {}, unknown: 1 }
    )
  ).rejects.toMatchObject({ statusCode: 409, code: 'REVISION_CONFLICT' });

  await expect(
    executeHelperCommand(
      helperChatStateCommand('chat.guide.update')!,
      { store, workspace },
      task,
      `${task.id}:guide-deleted`,
      chat.id,
      { expectedRevision: 0, changes: { unknown: true } }
    )
  ).rejects.toMatchObject({ statusCode: 409, code: 'REVISION_CONFLICT' });
});

test('Tx tokens cannot be forged or reused after a transaction closes', () => {
  const store = createStoreFixture();
  const chat = createFixtureChat(store, 'Tx boundary chat');
  const ports = createStorePorts(store);
  const forged = {} as Tx;

  expect(() =>
    saveChatVariableState(store, forged, chat.id, { revision: 1, values: { a: '1' } })
  ).toThrow('TRANSACTION_REQUIRED');
  expect(() =>
    store.storyGuide.save(forged, chat.id, 1, store.storyGuide.get(chat.id).config)
  ).toThrow('TRANSACTION_REQUIRED');
  expect(() =>
    ports.receipt.save(forged, { scope: chat.id, key: 'k', digest: 'd' }, { revision: 1 })
  ).toThrow('TRANSACTION_REQUIRED');

  let leaked!: Tx;
  ports.tx.transaction((tx) => {
    leaked = tx;
  });
  expect(() =>
    saveChatVariableState(store, leaked, chat.id, { revision: 1, values: { a: '1' } })
  ).toThrow('TRANSACTION_REQUIRED');
  expect(() =>
    store.storyGuide.save(leaked, chat.id, 1, store.storyGuide.get(chat.id).config)
  ).toThrow('TRANSACTION_REQUIRED');
});

test('outputPolicy always rolls back domain writes and receipt on invalid output while type-only commands skip runtime parsing', async () => {
  const store = createStoreFixture();
  const chat = createFixtureChat(store, 'Output rollback chat');
  const ports = createStorePorts(store);
  const strictOp = defineCommandOperation<{ ok: boolean; revision: number }>()({
    name: 'test.strictOutput',
    head: z.strictObject({ chatId: nonBlank(120), idempotencyKey: nonBlank(120) }),
    body: z.strictObject({}),
    output: z.strictObject({ ok: z.boolean(), revision: z.int().nonnegative() }),
    outputPolicy: 'always',
  });
  const afterCommit = vi.fn();
  const leakingCommand = defineCommand<Pick<AppPorts, 'tx' | 'receipt' | 'storyGuide'>>()(
    strictOp,
    {
      receipt: {
        scope: (head) => head.chatId,
        key: (head) => head.idempotencyKey,
        serialize: (output) => ({ revision: output.revision }),
        onReplay: () => ({ ok: true, revision: 1 }),
      },
      guard() {},
      apply(tx, applyPorts, input) {
        const current = applyPorts.storyGuide.get(input.chatId);
        applyPorts.storyGuide.save(tx, input.chatId, current.revision + 1, {
          ...current.config,
          enabled: true,
          work: 'Must roll back',
        });
        return { ok: true, revision: 1, apiKey: 'secret-value' } as unknown as {
          ok: boolean;
          revision: number;
        };
      },
      afterCommit,
    }
  );
  await expect(
    executeOperation(
      leakingCommand,
      ports,
      { chatId: chat.id, idempotencyKey: randomUUID() },
      { checkOutputs: false }
    )
  ).rejects.toBeInstanceOf(z.ZodError);
  expect(store.storyGuide.get(chat.id).revision).toBe(0);
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM chat_variable_journal WHERE chat_id=?').get(chat.id)
  ).toEqual({ n: 0 });
  expect(afterCommit).not.toHaveBeenCalled();

  const typeOnlyOp = defineCommandOperation<{ ok: boolean }>()({
    name: 'test.typeOnly',
    head: z.strictObject({ id: nonBlank(20) }),
    body: z.strictObject({}),
  });
  const typeOnlyCommand = defineCommand<Pick<AppPorts, 'tx'>>()(typeOnlyOp, {
    guard() {},
    apply() {
      return { ok: true, extra: 'passed-through' } as unknown as { ok: boolean };
    },
  });
  await expect(
    executeOperation(typeOnlyCommand, ports, { id: 'a' }, { checkOutputs: false })
  ).resolves.toEqual({ ok: true, extra: 'passed-through' });
});

test('type-level invariants reject body access in guard, async tx callbacks, invalid helper schemaBody, and missing outputPolicy always schemas', () => {
  const op = chatSettingsOperations.writeVariables;
  const _checkGuardCannotReadBody = defineCommand<Pick<AppPorts, 'tx'>>()(op, {
    guard(_tx, _ports, head) {
      // @ts-expect-error guard receives parsed head only and cannot read replace body fields
      void head.values;
      // @ts-expect-error guard receives parsed head only and cannot read patch body fields
      void head.set;
    },
    apply() {
      throw new AppError(400, 'INVALID_REQUEST');
    },
  });

  const _checkSyncGuard = defineCommand<Pick<AppPorts, 'tx'>>()(op, {
    // @ts-expect-error guard runs inside synchronous SQLite transaction and cannot be async
    async guard() {
      return 1;
    },
    apply() {
      throw new AppError(400, 'INVALID_REQUEST');
    },
  });

  const _checkSyncApply = defineCommand<Pick<AppPorts, 'tx'>>()(op, {
    guard() {},
    // @ts-expect-error apply runs inside synchronous SQLite transaction and cannot be async
    async apply() {
      throw new AppError(400, 'INVALID_REQUEST');
    },
  });

  defineHelperCommandTool({
    name: 'test.badBody',
    description: 'Mismatched schemaBody',
    command: updateStoryGuideCommand,
    // @ts-expect-error helper schemaBody must produce a valid body of the target command
    schemaBody: z.strictObject({ unrelated: z.string() }),
    omitHeadKeys: ['chatId'],
    formatResult: () => ({
      toolOutput: {},
      taskResult: { receiptId: 'r', operation: 'test.badBody', requestedTargets: 0, targets: [] },
    }),
  });

  // @ts-expect-error outputPolicy: 'always' requires an explicit Zod output schema
  defineCommandOperation<{ ok: boolean }>()({
    name: 'test.missingOutput',
    head: z.strictObject({ id: nonBlank(20) }),
    body: z.strictObject({}),
    outputPolicy: 'always',
  });

  expect([_checkGuardCannotReadBody, _checkSyncGuard, _checkSyncApply]).toHaveLength(3);
});
