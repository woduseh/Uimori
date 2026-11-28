import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod/v4';
import {
  chatSettingsEndpoints,
  defineEndpoint,
  endpointRequest,
  type OutlineApplyResult,
  outlineEndpoints,
} from '#contracts';
import {
  chatSettingsOperations,
  defineCommandOperation,
  nonBlank,
  splitHeadBody,
} from '#contracts/operations';
import { createApp, type App } from '../server/app.js';
import { AppError, assertRevision } from '../server/app-errors.js';
import { deleteChat } from '../server/chat-deletion.js';
import { readChatVariables, saveChatVariableState } from '../server/chat-variables.js';
import { type Command, defineCommand, executeOperation } from '../server/command.js';
import {
  allCommands,
  applyOutlineCommand,
  updateChatVariablesCommand,
  updateStoryGuideCommand,
} from '../server/commands/index.js';
import { registerCommand } from '../server/endpoint.js';
import { outlineWriteTool } from '../server/helper-app-tools.js';
import { helperChatStateCommand } from '../server/helper-chat-state-tools.js';
import { defineHelperCommandTool, executeHelperCommand } from '../server/helper-command-adapter.js';
import { rollBackHelperTask } from '../server/helper-rollback.js';
import { readHelperTaskResults } from '../server/helper-task-results.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { type AppPorts, createStorePorts } from '../server/store-ports.js';
import { Store } from '../server/store.js';
import type { Tx } from '../server/tx.js';
import { createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import { seedOutline } from './fixtures/outline.js';
import {
  helperCall,
  helperDone,
  runScriptedChatHelper,
  selectFixtureModels,
} from './fixtures/scripted-helper.js';

import { commandSamples } from './fixtures/command-samples.js';
import { analyzeSchema, valuesAtPath } from './stale-tab/schema.js';

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

const writes = (store: Store) => store.db.prepare('SELECT total_changes() AS count').get();

for (const registered of Object.values(allCommands)) {
  const name = registered.op.name;
  const command: Command<any, any> = registered;
  const { revisions, targets } = analyzeSchema(command.op.head);
  const paths = [...new Set([...revisions, ...targets])];
  const branches = analyzeSchema(command.op.body).branches;
  const arrange = (store: Store) => {
    const fixture = commandSamples[name];
    if (!fixture)
      throw new Error(`${name}: add a sample fixture in tests/fixtures/command-samples.ts`);
    const samples = fixture(store);
    if (!samples.inputs.length) throw new Error(`${name}: add a valid sample input`);
    return samples;
  };
  const breakBody = (sample: Record<string, unknown>) => {
    const { headRaw, bodyRaw } = splitHeadBody(command.op.head, sample);
    const broken = Object.fromEntries(Object.keys(bodyRaw).map((key) => [key, null]));
    return {
      ...headRaw,
      ...broken,
      ...(command.op.body.safeParse(broken).success ? { __invalidBodyField: true } : {}),
    };
  };
  const conflict = { statusCode: 409, code: 'REVISION_CONFLICT' };
  const scope = paths.length ? 'one event on success' : 'no target or revision probes';

  const applyBranches = branches.length ? branches : [undefined];
  for (const branch of applyBranches) {
    if (!branch && !paths.length && command.receipt) continue;
    test(`${name} applies ${branch?.label ?? 'body'} (${scope})`, async () => {
      const store = createStoreFixture();
      const { inputs } = arrange(store);
      const sample = inputs.find(
        (input) => !branch || branch.matches(splitHeadBody(command.op.head, input).bodyRaw)
      );
      if (!sample) throw new Error(`${name}: add a valid sample for body branch ${branch?.label}`);
      const publish = vi.fn();
      const onInTx = vi.fn();
      await executeOperation(command, createStorePorts(store, { publish }), sample, { onInTx });
      expect(onInTx.mock.calls[0]?.[1]).toMatchObject({ replayed: false });
      if (paths.length) expect(publish).toHaveBeenCalledTimes(1);
    });
  }

  for (const path of paths) {
    test(`${name} rejects stale ${path} before parsing the body without writing`, async () => {
      const store = createStoreFixture();
      const { inputs, stale } = arrange(store);
      const makeStale = stale?.[path];
      if (!makeStale) throw new Error(`${name}: add a stale-maker for head path ${path}`);
      const sample = inputs.find((input) =>
        valuesAtPath(input, path).some((value) => value !== undefined)
      );
      if (!sample) throw new Error(`${name}: add a valid sample containing head path ${path}`);
      const publish = vi.fn();
      const ports = createStorePorts(store, { publish });
      const broken = breakBody(sample);
      await expect(executeOperation(command, ports, broken)).rejects.toMatchObject({
        statusCode: 400,
        code: 'INVALID_REQUEST',
      });
      await makeStale(sample);
      const before = writes(store);
      await expect(executeOperation(command, ports, broken)).rejects.toMatchObject(conflict);
      expect(writes(store)).toEqual(before);
      expect(publish).not.toHaveBeenCalled();
    });
  }

  if (command.receipt) {
    test(`${name} replays its receipt and rejects a changed body (${revisions.length ? 'after guard state changes' : scope})`, async () => {
      const store = createStoreFixture();
      const { inputs, stale } = arrange(store);
      const sample = inputs[0]!;
      const publish = vi.fn();
      const ports = createStorePorts(store, { publish });
      const onReplay = vi.spyOn(command.receipt!, 'onReplay');
      await executeOperation(command, ports, sample);
      expect(onReplay).not.toHaveBeenCalled();
      const path = revisions.find((key) =>
        valuesAtPath(sample, key).some((value) => value !== undefined)
      );
      if (path) {
        const makeStale = stale?.[path];
        if (!makeStale) throw new Error(`${name}: add a stale-maker for head path ${path}`);
        await makeStale(sample);
      }
      const guard = vi.spyOn(command, 'guard');
      publish.mockClear();
      const before = writes(store);
      await executeOperation(command, ports, sample);
      expect(onReplay).toHaveBeenCalledOnce();
      await expect(executeOperation(command, ports, breakBody(sample))).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(guard).not.toHaveBeenCalled();
      expect(writes(store)).toEqual(before);
      expect(publish).not.toHaveBeenCalled();
    });
  }
}

test('outline receipt replays with reordered keys, keeps stored created ids, and returns current detail', async () => {
  const store = createStoreFixture();
  const { id: chatId } = createFixtureChat(store, 'Receipt outline chat');
  const publish = vi.fn();
  const ports = createStorePorts(store, { publish });
  const idempotencyKey = randomUUID();
  const first = await executeOperation(applyOutlineCommand, ports, {
    chatId,
    idempotencyKey,
    operations: [{ op: 'create', ref: 'arc1', level: 'arc', title: '1부', intent: '첫 구성' }],
  });
  expect(publish).toHaveBeenCalledTimes(1);

  seedOutline(store, chatId, [{ op: 'create', level: 'arc', title: '2부', intent: '후속 구성' }]);

  const replayed = await executeOperation(applyOutlineCommand, ports, {
    chatId,
    idempotencyKey,
    operations: [{ intent: '첫 구성', title: '1부', level: 'arc', ref: 'arc1', op: 'create' }],
  });
  expect(replayed.created).toEqual(first.created);
  expect(replayed.detail.nodes.map((node) => node.title)).toEqual(['1부', '2부']);
  expect(replayed).not.toEqual(first);
  expect(publish).toHaveBeenCalledTimes(1);
});

test('variable receipt returns the current view after the variables, source and busy state change', async () => {
  const store = createStoreFixture();
  const { id: chatId } = createFixtureChat(store, 'Receipt variables chat');
  const ports = createStorePorts(store);
  const head = {
    chatId,
    expectedRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: randomUUID(),
  };
  await executeOperation(updateChatVariablesCommand, ports, {
    ...head,
    values: { z: 'last', a: 'first' },
  });
  ports.tx.transaction((tx) => {
    ports.chatVariables.save(tx, chatId, { revision: 2, values: { a: 'updated-later' } });
  });
  completedSource(store, chatId, 'New scene after receipt');
  reserveRun(store, chatId);
  await expect(
    executeOperation(updateChatVariablesCommand, ports, {
      ...head,
      values: { a: 'first', z: 'last' },
    })
  ).resolves.toMatchObject({
    revision: 2,
    values: { a: 'updated-later' },
    pending: true,
  });
});

test.each(['same', 'different', 'absent'] as const)(
  'failed prepare rechecks a %s receipt',
  async (race) => {
    const store = createStoreFixture();
    const chat = createFixtureChat(store, 'Receipt race');
    const ports = createStorePorts(store);
    const input = {
      chatId: chat.id,
      expectedRevision: 0,
      expectedSourceHash: null,
      idempotencyKey: randomUUID(),
      values: { a: 'first' },
    };
    const failure = new Error('Draft consumed');
    const command = {
      ...updateChatVariablesCommand,
      async prepare() {
        if (race !== 'absent')
          await executeOperation(
            updateChatVariablesCommand,
            ports,
            race === 'same' ? input : { ...input, values: { a: 'other' } }
          );
        throw failure;
      },
    };
    const result = executeOperation(command, ports, input);
    if (race === 'absent') await expect(result).rejects.toBe(failure);
    else if (race === 'different') await expect(result).rejects.toMatchObject({ statusCode: 409 });
    else await expect(result).resolves.toMatchObject({ revision: 1, values: input.values });
  }
);

test('aborting in-flight preparation propagates the abort even after a duplicate commits', async () => {
  const store = createStoreFixture();
  const chat = createFixtureChat(store, 'Cancelled preparation');
  const ports = createStorePorts(store);
  const input = {
    chatId: chat.id,
    expectedRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: randomUUID(),
    values: { mood: 'steady' },
  };
  const controller = new AbortController();
  const prepare = () =>
    new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
    });
  const receipt = updateChatVariablesCommand.receipt!;
  const onReplay = vi.fn(receipt.onReplay);
  const aroundTx = vi.fn((run) => run());
  const onInTx = vi.fn();
  const result = executeOperation(
    { ...updateChatVariablesCommand, prepare, receipt: { ...receipt, onReplay } },
    ports,
    input,
    {
      signal: controller.signal,
      aroundTx,
      onInTx,
    }
  );
  await executeOperation(updateChatVariablesCommand, ports, input);
  controller.abort();
  await expect(result).rejects.toBe(controller.signal.reason);
  expect(aroundTx).not.toHaveBeenCalled();
  expect(onInTx).not.toHaveBeenCalled();
  expect(onReplay).not.toHaveBeenCalled();
});

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

  await expect(
    executeHelperCommand(
      outlineWriteTool,
      { store, workspace },
      task,
      `${task.id}:outline-deleted`,
      chat.id,
      { operations: 'not-an-array', unknown: 1 }
    )
  ).rejects.toMatchObject({ statusCode: 409, code: 'REVISION_CONFLICT' });

  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_changes WHERE task_id=?').get(task.id)
  ).toEqual({ n: 0 });
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
  ).toEqual({ n: 0 });
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM outline_batches WHERE chat_id=?').get(chat.id)
  ).toEqual({ n: 0 });
});

test('HTTP and helper produce the same stored state, compact receipt, and error codes for outline.apply', async () => {
  const app = await createAppFixture();
  const httpChat = createFixtureChat(app.store, 'HTTP outline');
  const helperChat = createFixtureChat(app.store, 'Helper outline');

  const initialBatch = [
    { op: 'create' as const, ref: 'arc1', level: 'arc' as const, title: '1부', intent: '출발' },
    {
      op: 'create' as const,
      ref: 'ep1',
      parentRef: 'arc1',
      level: 'episode' as const,
      title: '1화',
      intent: '여정의 시작',
      fixed: true,
    },
    {
      op: 'create' as const,
      ref: 'ep2',
      parentRef: 'arc1',
      level: 'episode' as const,
      title: '2화',
      intent: '갈등',
    },
  ];

  const httpCreate = await app.inject({
    method: 'POST',
    url: `/api${endpointRequest(outlineEndpoints.apply, { chatId: httpChat.id }).path}`,
    payload: { idempotencyKey: randomUUID(), operations: initialBatch },
  });
  expect(httpCreate.statusCode, httpCreate.body).toBe(200);
  const httpCreated = httpCreate.json<OutlineApplyResult>().created;

  const chatChanged = vi.fn();
  const helperCreate = await runScriptedChatHelper(
    app.store,
    helperChat.id,
    [helperCall('seed', 'outline.write', { operations: initialBatch as never }), helperDone],
    { chatChanged }
  );
  expect(helperCreate.finished('seed')).toMatchObject({ denied: false });
  const toolEvent = (
    helperCreate.requests[1]!.input.results as unknown as Array<{
      callId: string;
      result: unknown;
    }>
  ).find((item) => item.callId === 'seed');
  const receipt = toolEvent!.result as {
    operationId: string;
    applied: boolean;
    atomic: boolean;
    created: { ref?: string; id: string }[];
    changes: { op: string; id: string; revisionAfterOperation?: number }[];
  };
  expect(receipt.applied).toBe(true);
  expect(receipt.atomic).toBe(true);
  expect('detail' in receipt).toBe(false);
  expect(JSON.stringify(receipt).length).toBeLessThan(2000);
  expect(receipt.changes).toEqual(
    receipt.created.map((item) => ({ op: 'create', id: item.id, revisionAfterOperation: 1 }))
  );
  expect(chatChanged).toHaveBeenCalledTimes(1);
  expect(chatChanged).toHaveBeenCalledWith(helperChat.id);
  expect(readHelperTaskResults(app.store, helperCreate.task.id).unrecordedOperations).toBe(0);

  const shapeOf = (chatId: string) => {
    const nodes = app.store.outline.nodes(chatId);
    const titleById = new Map(nodes.map((node) => [node.id, node.title]));
    return nodes.map((node) => ({
      parentTitle: node.parentId ? (titleById.get(node.parentId) ?? null) : null,
      level: node.level,
      position: node.position,
      title: node.title,
      intent: node.intent,
      fixed: node.fixed,
      revision: node.revision,
      relatedTitles: (node.relatedIds ?? []).map((id) => titleById.get(id) ?? null),
    }));
  };
  expect(shapeOf(httpChat.id)).toEqual(shapeOf(helperChat.id));

  const idFor = (list: { ref?: string; id: string }[], ref: string) =>
    list.find((item) => item.ref === ref)!.id;
  const httpEp1 = idFor(httpCreated, 'ep1');
  const httpEp2 = idFor(httpCreated, 'ep2');
  const helperEp1 = idFor(receipt.created, 'ep1');
  const helperEp2 = idFor(receipt.created, 'ep2');

  const followUp = (ep1: string, ep2: string) => [
    {
      op: 'update' as const,
      id: ep1,
      expectedRevision: 1,
      intent: '수정된 의도',
      relatedIds: [ep2],
    },
    { op: 'move' as const, id: ep2, expectedRevision: 1, position: 2 },
  ];
  const httpFollow = await app.inject({
    method: 'POST',
    url: `/api/chats/${httpChat.id}/outline`,
    payload: { idempotencyKey: randomUUID(), operations: followUp(httpEp1, httpEp2) },
  });
  expect(httpFollow.statusCode, httpFollow.body).toBe(200);
  const helperFollow = await runScriptedChatHelper(app.store, helperChat.id, [
    helperCall('follow', 'outline.write', { operations: followUp(helperEp1, helperEp2) as never }),
    helperDone,
  ]);
  expect(helperFollow.finished('follow')).toMatchObject({ denied: false });
  expect(shapeOf(httpChat.id)).toEqual(shapeOf(helperChat.id));

  const tooManyRelated = Array.from({ length: 41 }, (_, i) => `related-id-${i}`);
  const errorCases: Array<{
    name: string;
    body: (ep1: string, ep2: string) => Record<string, unknown>;
    expectedCode: string;
  }> = [
    {
      name: 'stale-revision-atomic-rollback',
      body: (ep1) => ({
        operations: [
          { op: 'create', level: 'arc', title: '롤백되어야 함', intent: '실패 배치' },
          { op: 'update', id: ep1, expectedRevision: 1, title: '충돌' },
        ],
      }),
      expectedCode: 'REVISION_CONFLICT',
    },
    {
      name: 'hierarchy-invalid',
      body: (ep1) => ({
        operations: [
          { op: 'create', parentId: ep1, level: 'arc', title: '잘못된 계층', intent: '' },
        ],
      }),
      expectedCode: 'OUTLINE_HIERARCHY_INVALID',
    },
    {
      name: 'related-too-many',
      body: (ep1) => ({
        operations: [{ op: 'update', id: ep1, expectedRevision: 2, relatedIds: tooManyRelated }],
      }),
      expectedCode: 'OUTLINE_RELATED_TOO_MANY',
    },
    {
      name: 'empty-operations',
      body: () => ({ operations: [] }),
      expectedCode: 'INVALID_REQUEST',
    },
    {
      name: 'duplicate-ref',
      body: () => ({
        operations: [
          { op: 'create', ref: 'dup', level: 'arc', title: 'A', intent: '' },
          { op: 'create', ref: 'dup', level: 'arc', title: 'B', intent: '' },
        ],
      }),
      expectedCode: 'INVALID_REQUEST',
    },
    {
      name: 'duplicate-related',
      body: (ep1, ep2) => ({
        operations: [{ op: 'update', id: ep1, expectedRevision: 2, relatedIds: [ep2, ep2] }],
      }),
      expectedCode: 'INVALID_REQUEST',
    },
    {
      name: 'unknown-field',
      body: () => ({
        operations: [{ op: 'create', level: 'arc', title: 'A', intent: '' }],
        extra: 1,
      }),
      expectedCode: 'INVALID_REQUEST',
    },
  ];

  const helperErrors = await runScriptedChatHelper(app.store, helperChat.id, [
    ...errorCases.map((entry) =>
      helperCall(entry.name, 'outline.write', entry.body(helperEp1, helperEp2) as never)
    ),
    helperCall('spoof-idempotency', 'outline.write', {
      idempotencyKey: 'model-supplied',
      operations: [{ op: 'create', level: 'arc', title: 'spoof', intent: '' }],
    }),
    helperDone,
  ]);
  for (const entry of errorCases) {
    const httpRes = await app.inject({
      method: 'POST',
      url: `/api/chats/${httpChat.id}/outline`,
      payload: { idempotencyKey: randomUUID(), ...entry.body(httpEp1, httpEp2) },
    });
    expect(httpRes.json().code, `HTTP ${entry.name}`).toBe(entry.expectedCode);
    expect(helperErrors.finished(entry.name), `Helper ${entry.name}`).toMatchObject({
      denied: true,
      errorCode: entry.expectedCode,
    });
  }
  expect(helperErrors.finished('spoof-idempotency')).toMatchObject({
    denied: true,
    errorCode: 'INVALID_REQUEST',
  });
  expect(shapeOf(httpChat.id)).toEqual(shapeOf(helperChat.id));
  expect(app.store.outline.nodes(helperChat.id).some((n) => n.title === '롤백되어야 함')).toBe(
    false
  );
  expect(
    app.store.db
      .prepare('SELECT COUNT(*) AS n FROM helper_changes WHERE task_id=?')
      .get(helperErrors.task.id)
  ).toEqual({ n: 0 });
});

test('helper outline.write commits change card atomically, replays once, and restores on turn rollback', async () => {
  const store = createStoreFixture();
  const model = selectFixtureModels(store);
  const chat = createFixtureChat(store, 'Helper outline rollback chat');
  const seeded = seedOutline(store, chat.id, [
    { op: 'create', ref: 'arc', level: 'arc', title: '1부', intent: '원래 부 의도' },
    {
      op: 'create',
      ref: 'ep',
      parentRef: 'arc',
      level: 'episode',
      title: '1화',
      intent: '원래 화 의도',
      fixed: true,
    },
  ]);
  const arcId = seeded.find((item) => item.ref === 'arc')!.id;
  const epId = seeded.find((item) => item.ref === 'ep')!.id;
  const outlineTreeShape = () => {
    const nodes = store.outline.nodes(chat.id);
    const titleById = new Map(nodes.map((node) => [node.id, node.title]));
    return nodes.map((node) => ({
      parentTitle: node.parentId ? (titleById.get(node.parentId) ?? null) : null,
      level: node.level,
      position: node.position,
      title: node.title,
      intent: node.intent,
      fixed: node.fixed,
      relatedTitles: (node.relatedIds ?? []).map((id) => titleById.get(id) ?? null),
    }));
  };
  const beforeShape = outlineTreeShape();

  const workspace = new HelperWorkspace(store);
  const conversation = workspace.open({ kind: 'chat', chatId: chat.id });
  const task = workspace.enqueue(conversation.id, randomUUID(), 'Rewrite outline', {
    scope: { kind: 'chat', chatId: chat.id },
    model: store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    limits: { totalCalls: 4, helperCalls: 4 },
  });
  workspace.start(task.id, 'owner-1');
  const chatChanged = vi.fn();

  const failingBatch = {
    operations: [{ op: 'create', level: 'arc', title: '실패할 구성', intent: '롤백 확인' }],
  };
  vi.spyOn(workspace, 'event').mockImplementationOnce(() => {
    throw new Error('Injected outline helper event failure');
  });
  await expect(
    executeHelperCommand(
      outlineWriteTool,
      { store, workspace, chatChanged },
      task,
      `${task.id}:outline-atomic-fail`,
      chat.id,
      failingBatch
    )
  ).rejects.toThrow('Injected outline helper event failure');
  expect(store.outline.nodes(chat.id).map((node) => node.title)).toEqual(['1부', '1화']);
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_changes WHERE task_id=?').get(task.id)
  ).toEqual({ n: 0 });
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
  ).toEqual({ n: 0 });
  expect(chatChanged).not.toHaveBeenCalled();

  const rewriteArgs = {
    operations: [
      { op: 'update', id: arcId, expectedRevision: 1, title: '1부 개정', intent: '도우미 의도' },
      { op: 'remove', id: epId, expectedRevision: 1 },
      { op: 'create', parentId: arcId, level: 'episode', title: '새 1화', intent: '도우미 추가' },
    ],
  };
  const receiptId = `${task.id}:outline-rewrite`;
  const first = await executeHelperCommand(
    outlineWriteTool,
    { store, workspace, chatChanged },
    task,
    receiptId,
    chat.id,
    rewriteArgs
  );
  expect(first).toMatchObject({ operationId: receiptId, applied: true, atomic: true });
  expect(store.outline.nodes(chat.id).map((node) => node.title)).toEqual(['1부 개정', '새 1화']);
  expect(chatChanged).toHaveBeenCalledTimes(1);

  const replayed = await executeHelperCommand(
    outlineWriteTool,
    { store, workspace, chatChanged },
    task,
    receiptId,
    chat.id,
    rewriteArgs
  );
  expect(replayed).toEqual(first);
  expect(store.outline.nodes(chat.id).map((node) => node.title)).toEqual(['1부 개정', '새 1화']);
  expect(chatChanged).toHaveBeenCalledTimes(1);
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_changes WHERE task_id=?').get(task.id)
  ).toEqual({ n: 1 });

  workspace.finish(task.id, 'owner-1', task.generation + 1, 'completed', '완료했어요.', null);
  const rolled = rollBackHelperTask(store, workspace, task.id, undefined);
  expect(rolled.units).toMatchObject([{ unit: `outline:${chat.id}`, status: 'restored' }]);
  expect(outlineTreeShape()).toEqual(beforeShape);
  expect(store.outline.nodes(chat.id)[0]!.id).toBe(arcId);
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
  expect(() => store.outline.setFocus(forged, chat.id, null)).toThrow('TRANSACTION_REQUIRED');
  expect(() => store.outline.applyBatch(forged, chat.id, [])).toThrow('TRANSACTION_REQUIRED');
  expect(() =>
    ports.outlineReceipt.save(
      forged,
      { scope: chat.id, key: 'k', digest: 'd' },
      { authority: 'user', operations: [], created: [] }
    )
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
  expect(() => store.outline.setFocus(leaked, chat.id, null)).toThrow('TRANSACTION_REQUIRED');
  expect(() => store.outline.applyBatch(leaked, chat.id, [])).toThrow('TRANSACTION_REQUIRED');
  expect(() =>
    ports.outlineReceipt.save(
      leaked,
      { scope: chat.id, key: 'k', digest: 'd' },
      { authority: 'user', operations: [], created: [] }
    )
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

  const _checkSyncGuardVoid = defineCommand<Pick<AppPorts, 'tx'>>()(op, {
    // @ts-expect-error void async guard runs inside synchronous SQLite transaction and cannot be async
    async guard() {},
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

  const _checkSyncOnInTx = () =>
    executeOperation(
      updateStoryGuideCommand,
      null as unknown as AppPorts,
      {},
      {
        // @ts-expect-error onInTx runs inside synchronous SQLite transaction and cannot be async
        async onInTx() {
          await Promise.resolve();
        },
      }
    );

  const _checkSyncAroundApply = () =>
    executeOperation(
      applyOutlineCommand,
      null as unknown as AppPorts,
      {},
      {
        // @ts-expect-error aroundApply runs inside synchronous SQLite transaction and cannot be async
        async aroundApply(_tx, _input, run) {
          return run();
        },
      }
    );

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

  expect([
    _checkGuardCannotReadBody,
    _checkSyncGuard,
    _checkSyncGuardVoid,
    _checkSyncApply,
    _checkSyncOnInTx,
    _checkSyncAroundApply,
  ]).toHaveLength(6);
});

test('registerCommand keeps prepare signal alive after request body completes and aborts only on early client disconnect', async () => {
  const store = createStoreFixture();
  const ports = createStorePorts(store);
  const op = defineCommandOperation<{ id: string; note: string; aborted: boolean }>()({
    name: 'test.prepareAbort',
    head: z.strictObject({ id: nonBlank(40) }),
    body: z.strictObject({ note: nonBlank(40) }),
  });
  const endpoint = defineEndpoint<typeof op>()({
    operation: 'test.prepareAbort',
    method: 'PUT',
    path: '/prepare-abort/:id',
  });

  let disconnectEntered!: () => void;
  const disconnectPrepareReady = new Promise<void>((resolveReady) => {
    disconnectEntered = resolveReady;
  });
  let disconnectSignalBeforeClose: boolean | undefined;
  let disconnectAborted!: () => void;
  const disconnectSignalAborted = new Promise<void>((resolveAborted) => {
    disconnectAborted = resolveAborted;
  });
  const appliedIds: string[] = [];

  const command = defineCommand<Pick<AppPorts, 'tx'>>()(op, {
    async prepare(_ports, head, _raw, signal) {
      if (head.id === 'normal') {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        signal?.throwIfAborted();
        return { aborted: signal?.aborted ?? false };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      disconnectSignalBeforeClose = signal?.aborted;
      disconnectEntered();
      await new Promise<void>((resolveWait, rejectWait) => {
        if (signal?.aborted) {
          disconnectAborted();
          resolveWait();
          return;
        }
        const timer = setTimeout(() => rejectWait(new Error('Expected abort on disconnect')), 2000);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            disconnectAborted();
            resolveWait();
          },
          { once: true }
        );
      });
      signal?.throwIfAborted();
      return { aborted: true };
    },
    guard() {},
    apply(_tx, _ports, input, _guarded, prepared) {
      appliedIds.push(input.id);
      return { id: input.id, note: input.note, aborted: prepared.aborted };
    },
  });

  const server = Fastify({ logger: false });
  registerCommand(server, endpoint, command, ports);
  const address = await server.listen({ port: 0, host: '127.0.0.1' });
  try {
    const normalRes = await fetch(`${address}/api/prepare-abort/normal`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'steady' }),
    });
    expect(normalRes.status).toBe(200);
    await expect(normalRes.json()).resolves.toEqual({
      id: 'normal',
      note: 'steady',
      aborted: false,
    });

    const url = new URL('/api/prepare-abort/disconnect', address);
    const body = JSON.stringify({ note: 'drop-me' });
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    });
    req.on('error', () => {});
    req.end(body);

    await disconnectPrepareReady;
    expect(disconnectSignalBeforeClose).toBe(false);
    req.destroy();
    await disconnectSignalAborted;
    expect(appliedIds).toEqual(['normal']);
  } finally {
    await server.close();
  }
});

test('a runtime async onInTx or aroundApply hook throws synchronously, rolls back writes, and skips afterCommit', async () => {
  const store = createStoreFixture();
  const chat = createFixtureChat(store, 'Async onInTx rollback chat');
  const publish = vi.fn();
  const ports = createStorePorts(store, { publish });

  await expect(
    executeOperation(
      updateStoryGuideCommand,
      ports,
      { chatId: chat.id, expectedRevision: 0, changes: { enabled: true, work: 'Must roll back' } },
      {
        onInTx: (async () => {
          await Promise.resolve();
          throw new Error('late async hook failure');
        }) as unknown as () => void,
      }
    )
  ).rejects.toThrow('Async onInTx callback');

  await expect(
    executeOperation(
      applyOutlineCommand,
      ports,
      {
        chatId: chat.id,
        idempotencyKey: randomUUID(),
        operations: [{ op: 'create', level: 'arc', title: '롤백', intent: '' }],
      },
      {
        aroundApply: (async (_tx: Tx, _input: unknown, run: () => unknown) => {
          const result = run();
          await Promise.resolve();
          return result;
        }) as unknown as <T>(_tx: Tx, _input: unknown, run: () => T) => T,
      }
    )
  ).rejects.toThrow('Async aroundApply callback');

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  expect(store.storyGuide.get(chat.id).revision).toBe(0);
  expect(store.outline.nodes(chat.id)).toEqual([]);
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM outline_batches WHERE chat_id=?').get(chat.id)
  ).toEqual({ n: 0 });
  expect(publish).not.toHaveBeenCalled();
});

test('op.input and executeOperation parse transforming body fields once and agree on the result', async () => {
  const store = createStoreFixture();
  const ports = createStorePorts(store);
  let transformCount = 0;
  const amountField = z.string().transform((raw) => {
    transformCount += 1;
    return Number(raw);
  });
  const op = defineCommandOperation<{ id: string; amount: number }>()({
    name: 'test.transformBody',
    head: z.strictObject({ id: nonBlank(20) }),
    body: z.union([
      z.strictObject({ amount: amountField }),
      z.strictObject({ label: nonBlank(20) }),
    ]),
  });
  const command = defineCommand<Pick<AppPorts, 'tx'>>()(op, {
    guard() {},
    apply(_tx, _ports, input) {
      return { id: input.id, amount: 'amount' in input ? input.amount : -1 };
    },
  });

  const parsed = op.input.safeParse({ id: 'x', amount: '3' });
  expect(parsed).toEqual({ success: true, data: { id: 'x', amount: 3 } });
  expect(transformCount).toBe(1);

  const executed = await executeOperation(command, ports, { id: 'x', amount: '3' });
  expect(executed).toEqual({ id: 'x', amount: 3 });
  expect(transformCount).toBe(2);

  expect(op.input.safeParse({ id: 'x', amount: 3 }).success).toBe(false);
  await expect(executeOperation(command, ports, { id: 'x', amount: 3 })).rejects.toMatchObject({
    statusCode: 400,
    code: 'INVALID_REQUEST',
  });
  expect(op.input.safeParse({ id: 'x', amount: '3', extra: 1 }).success).toBe(false);
  await expect(
    executeOperation(command, ports, { id: 'x', amount: '3', extra: 1 })
  ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' });
});
