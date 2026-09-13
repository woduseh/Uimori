import { afterEach, expect, test, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Run } from '../server/store.js';
import { productRoutes } from '../server/product-routes.js';
import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import type { Content } from '../core/product.js';
import { packageInstanceId } from '../core/execution-context.js';
import {
  behaviorDetail,
  freezePackageStates,
  performBehaviorAction,
  performBehaviorActionWithProgram,
} from '../server/package-behavior-host.js';
import { forkChat } from '../server/chat-fork.js';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import type { RuntimeValue } from '../core/prompt-values.js';
import * as extensionRuntime from '../server/extension-runtime.js';
import { readChatVariables, writeChatVariables } from '../server/chat-variables.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';

const owned: { store: Store; app: FastifyInstance; dir: string }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { store, app, dir } of owned.splice(0).reverse()) {
    await app.close();
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-extension-action-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

function packageDefinition(): ContentPackage {
  return validateContentPackage({
    version: 1,
    id: 'extension-action-fixture',
    revision: 1,
    title: 'Synthetic extension action',
    description: 'Isolated integration fixture',
    body: 'Synthetic only.',
    lore: [],
    controls: [],
    transforms: [],
    instructions: [],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      mode: 'authoritative',
      stateSchema: {
        type: 'record',
        properties: { count: { type: 'number', min: 0, max: 10_000, integer: true } },
      },
      initialState: { count: 0 },
      actions: [
        {
          id: 'compute',
          inputSchema: {
            type: 'record',
            properties: { amount: { type: 'number', min: 1, max: 100, integer: true } },
          },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            source:
              'let delta = 0; for (let step = 1; step <= api.input.amount; step++) delta += step; return {state: {count: api.state.count + delta}, result: {applied: true, delta}};',
          },
        },
        {
          id: 'invalid-state',
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            source: 'return {state: {count: -1}, result: {applied: true}};',
          },
        },
        {
          id: 'invalid-output',
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            source: 'return {state: {count: api.state.count}};',
          },
        },
        {
          id: 'guest-throws',
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            source: 'throw new Error("PRIVATE_GUEST_FAILURE_TEXT");',
          },
        },
        {
          id: 'ordinary',
          inputSchema: {
            type: 'record',
            properties: { amount: { type: 'number', min: 1, max: 100, integer: true } },
          },
          effects: [
            {
              path: ['count'],
              value: {
                op: 'add',
                args: [{ context: ['state', 'count'] }, { context: ['input', 'amount'] }],
              },
            },
          ],
        },
      ],
      outputParsers: [],
    },
    panels: [
      {
        id: 'counter',
        title: 'Counter',
        actions: ['compute', 'ordinary'],
        template: [
          { kind: 'text', text: '<output id="count">' },
          { kind: 'value', expression: { context: ['state', 'count'] } },
          { kind: 'text', text: '</output>' },
        ],
      },
    ],
  });
}

function fixture(pkg = packageDefinition()) {
  const { dir, store, app } = database();
  const content = store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(store, 'Synthetic extension action', 'calm', {
    botId: content.id,
  });
  const branchId = `main:${chat.id}`;
  const instanceId = packageInstanceId({ id: content.id, revision: content.revision, role: 'bot' });
  const endpoint = `/api/chats/${chat.id}/package-behaviors/${instanceId}/actions`;
  return { app, store, pkg, content, chat, branchId, instanceId, endpoint, dir };
}

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-extension-action-'));
  const store = new Store(join(dir, 'test.sqlite'));
  const app = Fastify();
  owned.push({ store, app, dir });
  productRoutes(app, store, { approvedOrigins: [], publish: () => {} });
  return { dir, store, app };
}

type Fixture = ReturnType<typeof fixture>;

function command(
  f: Fixture,
  actionId: string,
  input: RuntimeValue,
  idempotencyKey: string = randomUUID()
) {
  const detail = behaviorDetail(f.store, f.chat.id);
  return {
    actionId,
    input,
    expectedStateRevision: detail.instances[0].stateRevision,
    expectedSourceHash: detail.sourceHash,
    idempotencyKey,
  };
}

function postAction(f: Fixture, payload: Record<string, unknown>) {
  return injectWithFixtureBot(f.app, {
    method: 'POST',
    url: f.endpoint,
    payload,
  });
}

test('user variable mutation reserves the adopted next request once and preserves its projection through archive and chat backup', async () => {
  const pkg = packageDefinition(),
    action = pkg.behavior!.actions[0];
  pkg.variableDefaults = { values: { fallback: 'authored default' } };
  action.inputSchema = {
    type: 'record',
    properties: {
      amount: { type: 'number', min: 1, max: 100, integer: true },
      target: { type: 'string', maxLength: 200 },
    },
  };
  action.program = {
    api: EXTENSION_PROGRAM_API,
    capabilities: ['variables.read', 'variables.write'],
    source:
      'await api.host.call("variables.set", {key:"target",value:api.input.target}); await api.host.call("variables.delete", {key:"fallback"}); return {state:{count:api.state.count+api.input.amount}, result:null};',
  };
  action.nextRequest = {
    op: 'join',
    args: [
      {
        op: 'array',
        args: [{ context: ['variables', 'target'] }, { context: ['variables', 'fallback'] }],
      },
      '|',
    ],
  };
  const f = fixture(pkg),
    profile = f.store.product.profile(f.chat.id);
  f.store.product.updateProfile(f.chat.id, {
    expectedRevision: profile.revision,
    attachments: profile.attachments,
    packageAttachments: profile.packageAttachments,
    image: profile.image,
    extensionGrants: {
      [f.instanceId]: { packageRevision: f.content.revision, capabilities: ['variables.write'] },
    },
  });
  writeChatVariables(f.store, f.chat.id, f.branchId, {
    expectedRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'request-variable-base',
    values: { target: 'before', fallback: 'temporary override' },
  });
  // ID-shaped text is user data and must not change when backup ownership IDs are remapped.
  const payload = command(f, 'compute', { amount: 1, target: f.chat.id }, 'variable-next-request');
  const first = await postAction(f, payload);
  expect(first.statusCode, first.body).toBe(200);
  const request = first.json().pendingRequest;
  expect(request).toMatchObject({
    request: `${f.chat.id}|authored default`,
    variableContext: {
      variableStateRevision: 2,
      variables: { target: f.chat.id, fallback: 'authored default' },
    },
  });
  expect(readChatVariables(f.store, f.chat.id, f.branchId)).toEqual({
    revision: 2,
    values: { target: f.chat.id },
  });
  const replay = await postAction(f, payload);
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().pendingRequest).toEqual(request);
  expect(readChatVariables(f.store, f.chat.id, f.branchId).revision).toBe(2);
  expect(f.store.db.prepare('SELECT count(*) AS n FROM package_requests').get()!.n).toBe(1);
  const archive = f.store.product.export(),
    restored = database();
  restored.store.product.import(archive);
  expect(behaviorDetail(restored.store, f.chat.id).pendingRequest).toEqual(request);
  expect(readChatVariables(restored.store, f.chat.id, f.branchId)).toEqual({
    revision: 2,
    values: { target: f.chat.id },
  });
  for (const alter of [
    (context: any) => {
      context.variableStateRevision++;
    },
    (context: any) => {
      context.variables.target = 'forged';
    },
    (context: any) => {
      context.variableDefaultsError = 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT';
    },
    (context: any) => {
      context.extra = true;
    },
    (context: any) => {
      context.variables.target = 'x'.repeat(200001);
    },
  ]) {
    const changed = structuredClone(archive),
      row = changed.tables.package_requests[0],
      body = JSON.parse(row.body);
    alter(body.variableContext);
    row.body = JSON.stringify(body);
    const target = database(),
      before = target.store.product.export().tables;
    expect(() => target.store.product.import(changed)).toThrow();
    expect(target.store.product.export().tables).toEqual(before);
  }
  const copied = importChatBackup(f.store, {
    backup: exportChatBackup(f.store, f.chat.id),
    idempotencyKey: 'copy-variable-request',
  });
  const imported = behaviorDetail(f.store, copied.chat.id).pendingRequest;
  expect(imported?.request).toBe(request.request);
  expect(imported?.variableContext).toEqual(request.variableContext);
  expect(
    readChatVariables(f.store, copied.chat.id, f.store.product.branch(copied.chat.id).id)
  ).toEqual({ revision: 2, values: { target: f.chat.id } });
});

function createPendingRun(f: Fixture): Run {
  const chat = f.store.chat(f.chat.id);
  const profile = f.store.product.snapshot(chat.id);
  const snapshot = freezePackageStates(
    f.store,
    {
      chatId: chat.id,
      branchId: f.branchId,
      parentRevision: null,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Synthetic request',
      history: [],
      profile,
      resources: f.store.product.resources(chat.id, profile),
    },
    true
  );
  return f.store.createRun(
    chat.id,
    {
      request: snapshot.request,
      expectedRevision: snapshot.parentRevision,
      expectedSettingsRevision: snapshot.settingsRevision,
      branchId: f.branchId,
      idempotencyKey: randomUUID(),
    },
    () => snapshot
  ).run;
}

function complete(f: Fixture, run: Run) {
  expect(f.store.startRun(run.id)).toBe(true);
  return f.store.completeRun(
    run.id,
    'Synthetic source.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}

test('real HTTP program computes state, renders the panel and replays one durable receipt', async () => {
  const f = fixture();
  const payload = command(f, 'compute', { amount: 4 }, 'program-success');
  const first = await postAction(f, payload);
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 10 },
    lastAction: {
      actionId: 'compute',
      result: { applied: true, delta: 10 },
      stateRevision: 1,
      trigger: 'user',
    },
  });
  expect(first.json().instances[0].panels[0].html).toContain('<output id="count">10</output>');

  const replay = await postAction(f, payload);
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().instances[0].stateRevision).toBe(1);
  expect(
    f.store.behavior.journal({
      chatId: f.chat.id,
      branchId: f.branchId,
      attachmentInstanceId: f.instanceId,
      packageId: f.content.id,
      packageRevision: f.content.revision,
      behaviorRevision: 1,
      schemaVersion: 1,
    })
  ).toHaveLength(1);
  const row = f.store.db.prepare('SELECT payload FROM package_behavior_journal').get() as {
    payload: string;
  };
  expect(JSON.parse(row.payload).program).toMatchObject({
    api: EXTENSION_PROGRAM_API,
    engine: expect.any(String),
    programHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    state: { count: 10 },
    result: { applied: true, delta: 10 },
  });
});

test('HTTP cannot supply a program result or host-owned runtime fields', async () => {
  for (const forged of [
    { program: { api: EXTENSION_PROGRAM_API, source: 'return null;' } },
    { hostRuntime: { profile: { revision: 999 } } },
    { resolvedProgram: { state: { count: 99 }, result: null, engine: 'forged' } },
  ]) {
    const f = fixture();
    const response = await postAction(f, {
      ...command(f, 'compute', { amount: 2 }),
      ...forged,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
      stateRevision: 0,
      state: { count: 0 },
    });
    expect(
      f.store.db.prepare('SELECT count(*) AS count FROM package_behavior_journal').get()
    ).toEqual({ count: 0 });
  }
});

test('invalid guest output leaves no state while an ordinary action remains usable', async () => {
  for (const actionId of ['invalid-state', 'invalid-output']) {
    const f = fixture();
    const failed = await postAction(f, command(f, actionId, {}));
    expect(failed.statusCode, failed.body).toBe(400);
    expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
      stateRevision: 0,
      state: { count: 0 },
    });
    const ordinary = await postAction(f, command(f, 'ordinary', { amount: 3 }));
    expect(ordinary.statusCode, ordinary.body).toBe(200);
    expect(ordinary.json().instances[0]).toMatchObject({
      stateRevision: 1,
      state: { count: 3 },
    });
  }
});

test('guest exceptions return a generic failure and preserve the branch for a later Run', async () => {
  const f = fixture();
  const failed = await postAction(f, command(f, 'guest-throws', {}));
  expect(failed.statusCode, failed.body).toBe(400);
  expect(failed.body).not.toContain('PRIVATE_GUEST_FAILURE_TEXT');
  expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 0,
    state: { count: 0 },
  });
  const run = createPendingRun(f);
  const source = complete(f, run);
  expect(source.text).toBe('Synthetic source.');
  expect(f.store.run(run.id).status).toBe('completed');
});

test('a late program result cannot overwrite intervening state or profile changes', async () => {
  for (const mutate of ['state', 'profile'] as const) {
    const f = fixture();
    let release!: (
      value: Awaited<ReturnType<typeof extensionRuntime.executeExtensionProgram>>
    ) => void;
    vi.spyOn(extensionRuntime, 'executeExtensionProgram').mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    );
    const pending = performBehaviorActionWithProgram(
      f.store,
      f.chat.id,
      f.branchId,
      f.instanceId,
      command(f, 'compute', { amount: 2 }, `late-${mutate}`)
    );
    if (mutate === 'state') {
      performBehaviorAction(
        f.store,
        f.chat.id,
        f.branchId,
        f.instanceId,
        command(f, 'ordinary', { amount: 7 }, 'intervening-state')
      );
    } else {
      const profile = f.store.product.profile(f.chat.id);
      f.store.product.updateProfile(f.chat.id, {
        expectedRevision: profile.revision,
        attachments: profile.attachments,
        image: profile.image,
      });
    }
    release({ state: { count: 3 }, result: { applied: true }, engine: 'test-gate-v1' });
    await expect(pending).rejects.toThrow('BEHAVIOR_PROGRAM_CONTEXT_CHANGED');
    expect(behaviorDetail(f.store, f.chat.id).instances[0]).toMatchObject(
      mutate === 'state'
        ? { stateRevision: 1, state: { count: 7 } }
        : { stateRevision: 0, state: { count: 0 } }
    );
    vi.restoreAllMocks();
  }
});

test('an active Run rejects a late result, while fork and archive preserve accepted state without execution', async () => {
  const f = fixture();
  let release!: (
    value: Awaited<ReturnType<typeof extensionRuntime.executeExtensionProgram>>
  ) => void;
  const gate = vi
    .spyOn(extensionRuntime, 'executeExtensionProgram')
    .mockImplementation(() => new Promise((resolve) => (release = resolve)));
  const pending = performBehaviorActionWithProgram(
    f.store,
    f.chat.id,
    f.branchId,
    f.instanceId,
    command(f, 'compute', { amount: 2 }, 'late-run')
  );
  const active = createPendingRun(f);
  release({ state: { count: 3 }, result: { applied: true }, engine: 'test-gate-v1' });
  await expect(pending).rejects.toThrow('BEHAVIOR_RUN_ACTIVE');
  expect(behaviorDetail(f.store, f.chat.id).instances[0].stateRevision).toBe(0);
  f.store.finishRun(active.id, 'cancelled', 'Synthetic race completed');
  gate.mockRestore();

  const accepted = await postAction(f, command(f, 'compute', { amount: 3 }, 'accepted'));
  expect(accepted.statusCode, accepted.body).toBe(200);
  const source = complete(f, createPendingRun(f));
  const fork = forkChat(f.store, f.chat.id, {
    fromRevision: source.id,
    title: 'Synthetic extension fork',
    idempotencyKey: randomUUID(),
  });
  expect(behaviorDetail(f.store, fork.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 6 },
  });

  const archive = f.store.product.export();
  const receipt = JSON.parse(String(archive.tables.package_behavior_journal[0].payload)).program;
  const restored = database();
  const execute = vi.spyOn(extensionRuntime, 'executeExtensionProgram');
  expect(restored.store.product.import(archive)).toEqual({ restored: true, chats: 2 });
  expect(execute).not.toHaveBeenCalled();
  expect(behaviorDetail(restored.store, f.chat.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 6 },
  });
  const restoredRow = restored.store.db
    .prepare('SELECT payload FROM package_behavior_journal WHERE idempotency_key=?')
    .get('accepted') as { payload: string };
  expect(JSON.parse(restoredRow.payload).program).toEqual(receipt);
});
