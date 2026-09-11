import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import {
  ChatOptionsStore,
  chatOptionGrants,
  optionBinding,
  invokeHelperOptions,
  validateChatOptionArchive,
  type ChatOptionAuthority,
} from '../server/chat-options.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import {
  defaultPromptWorkspace,
  freezeCurrentPrompts,
  promptWorkspace,
  updatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { forkChat } from '../server/chat-fork.js';
import type { OptionValues } from '../core/chat-options.js';
import type { HelperTask } from '../core/helper.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const inside = relative(tmpdir(), path);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-chat-options-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
const authority: ChatOptionAuthority = { requestId: 'direct-ui-action', assert: () => {} };
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-chat-options-')),
    store = new Store(join(path, 'test.sqlite'));
  owned.push({ store, path });
  return store;
}
function fixture() {
  const store = database();
  const prior = promptWorkspace(store);
  updatePromptWorkspace(store, {
    expectedRevision: prior.revision,
    main: {
      ...prior.main,
      values: { tone: 'calm', detail: 1 },
      program: {
        ...prior.main.program,
        controls: [
          {
            id: 'tone',
            label: 'Tone',
            type: 'select',
            default: 'calm',
            options: [
              { label: 'Calm', value: 'calm' },
              { label: 'Bold', value: 'bold' },
              { label: 'Warm', value: 'warm' },
            ],
          },
          { id: 'detail', label: 'Detail', type: 'number', default: 1, min: 0, max: 9 },
        ],
      },
    },
  });
  const chat = createFixtureChat(store, 'Options', 'calm'),
    service = new ChatOptionsStore(store);
  return { store, chat, service };
}
function input(f: ReturnType<typeof fixture>, values: OptionValues, branchId?: string) {
  const state = f.service.get(f.chat.id, branchId);
  return {
    branchId: state.branchId,
    expectedRevision: state.revision,
    binding: state.binding,
    values,
    operationId: randomUUID(),
  };
}
function stage(f: ReturnType<typeof fixture>, values: OptionValues, delegationId?: string) {
  const state = f.service.get(f.chat.id);
  return f.service.stage(
    f.chat.id,
    {
      ...input(f, values),
      expectedHeadRevision: state.headRevision,
      ...(delegationId ? { delegationId } : {}),
    },
    authority,
    !!delegationId
  );
}
function delegate(f: ReturnType<typeof fixture>, fields = ['detail']) {
  const state = f.service.get(f.chat.id);
  return f.service
    .delegate(
      f.chat.id,
      {
        branchId: state.branchId,
        expectedRevision: state.revision,
        binding: state.binding,
        fields,
        operationId: randomUUID(),
      },
      authority
    )
    .delegations.at(-1)!;
}
function command(f: ReturnType<typeof fixture>) {
  const chat = f.store.chat(f.chat.id),
    branch = f.store.product.branch(chat.id);
  return {
    request: 'Synthetic continuation',
    expectedRevision: branch.headRevision,
    expectedSettingsRevision: chat.settingsRevision,
    branchId: branch.id,
    idempotencyKey: randomUUID(),
  };
}
function run(f: ReturnType<typeof fixture>, cmd = command(f)) {
  return f.store.createRun(f.chat.id, cmd, (chat) => {
    const profile = f.store.product.snapshot(chat.id);
    return {
      chatId: chat.id,
      parentRevision: cmd.expectedRevision,
      settings: chat.settings,
      settingsRevision: chat.settingsRevision,
      request: cmd.request,
      history: f.store.history(cmd.expectedRevision),
      resources: f.store.product.resources(chat.id, profile),
      profile,
    };
  });
}
function complete(f: ReturnType<typeof fixture>, id: string) {
  f.store.startRun(id);
  return f.store.completeRun(
    id,
    `Synthetic ${id}`,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    { ...f.store.run(id).snapshot.settings, status: false }
  );
}
test('global, chat fixed, delegated unfixed and explicit oneoff resolve once in the reservation transaction', () => {
  const f = fixture();
  f.service.fixed(f.chat.id, input(f, { tone: 'bold' }), authority);
  const grant = delegate(f);
  stage(f, { detail: 4 }, grant.id);
  stage(f, { tone: 'warm', detail: 7 });
  const cmd = command(f),
    first = run(f, cmd);
  const resolution = first.run.snapshot.profile!.chatOptions!;
  expect(resolution).toMatchObject({
    globalValues: { tone: 'calm', detail: 1 },
    fixedValues: { tone: 'bold' },
    delegatedValues: { detail: 4 },
    oneoffValues: { tone: 'warm', detail: 7 },
    values: { tone: 'warm', detail: 7 },
  });
  expect(resolution.pendingIds).toHaveLength(2);
  expect(f.service.get(f.chat.id).pending).toEqual([]);
  expect(run(f, cmd)).toEqual({ run: first.run, created: false });
  expect(promptWorkspace(f.store).main.values).toEqual({ tone: 'calm', detail: 1 });
  complete(f, first.run.id);
  const next = run(f);
  expect(next.run.snapshot.profile!.chatOptions!.values).toEqual({ tone: 'bold', detail: 1 });
});
test('failed reservation rolls back oneoff consumption and changed global values remain independent of the definition binding', () => {
  const f = fixture();
  stage(f, { detail: 5 });
  expect(() =>
    f.store.transaction(() => {
      run(f);
      throw new Error('reservation failed');
    })
  ).toThrow('reservation failed');
  expect(f.service.get(f.chat.id).pending).toHaveLength(1);
  const oldBinding = f.service.get(f.chat.id).binding,
    current = promptWorkspace(f.store);
  updatePromptWorkspace(f.store, {
    expectedRevision: current.revision,
    main: { ...current.main, values: { tone: 'warm', detail: 3 } },
  });
  expect(f.service.get(f.chat.id).binding).toEqual(oldBinding);
  const value = run(f).run;
  expect(value.snapshot.profile!.chatOptions!.values).toEqual({ tone: 'warm', detail: 5 });
  expect(f.service.get(f.chat.id).pending).toEqual([]);
});
test('explicit UI capabilities, definition owner, CAS, fixed fields and revocation bound delegated choices', () => {
  const f = fixture(),
    initial = input(f, { tone: 'bold' });
  expect(() =>
    f.service.fixed(f.chat.id, initial, {
      ...authority,
      assert: () => {
        throw new Error('denied');
      },
    })
  ).toThrow('denied');
  const accepted = f.service.fixed(f.chat.id, initial, authority);
  expect(f.service.fixed(f.chat.id, initial, authority)).toEqual(accepted);
  expect(() =>
    f.service.fixed(f.chat.id, { ...initial, operationId: randomUUID() }, authority)
  ).toThrow(/변경/);
  expect(() =>
    f.service.fixed(
      f.chat.id,
      {
        ...input(f, { tone: 'bold' }),
        binding: { ...accepted.binding, owner: 'preset:unrelated' },
      },
      authority
    )
  ).toThrow(/소속/);
  const grant = delegate(f, ['tone', 'detail']);
  expect(() => stage(f, { tone: 'warm' }, grant.id)).toThrow(/고정/);
  stage(f, { detail: 4 }, grant.id);
  const state = f.service.get(f.chat.id);
  f.service.revoke(
    f.chat.id,
    grant.id,
    { branchId: state.branchId, expectedRevision: state.revision, operationId: randomUUID() },
    authority
  );
  expect(f.service.get(f.chat.id).delegations[0]).toMatchObject({
    revision: 2,
    fields: ['tone', 'detail'],
    revokedAt: expect.any(String),
  });
  expect(f.service.get(f.chat.id).pending).toEqual([]);
  expect(() => stage(f, { detail: 4 }, grant.id)).toThrow(/위임/);
  expect(() =>
    f.service.fixed(f.chat.id, input(f, { modelId: 'foreign-model' }), authority)
  ).toThrow();
  expect(() =>
    f.service.delegate(
      f.chat.id,
      {
        branchId: state.branchId,
        expectedRevision: f.service.get(f.chat.id).revision,
        binding: state.binding,
        fields: ['modelId'],
        operationId: randomUUID(),
      },
      authority
    )
  ).toThrow(/실제/);
});
test('definition changes block pending choices and never silently apply old fixed or delegated fields', () => {
  const f = fixture();
  f.service.fixed(f.chat.id, input(f, { tone: 'bold' }), authority);
  stage(f, { detail: 4 });
  const current = promptWorkspace(f.store);
  updatePromptWorkspace(f.store, {
    expectedRevision: current.revision,
    main: {
      ...current.main,
      program: {
        ...current.main.program,
        controls: current.main.program.controls.map((item) =>
          item.id === 'detail' ? { ...item, max: 8 } : item
        ),
      },
    },
  });
  expect(f.service.get(f.chat.id).fixedValues).toEqual({});
  expect(f.service.get(f.chat.id).conflicts.length).toBeGreaterThan(0);
  expect(() => run(f)).toThrow(/再|다시/);
  const state = f.service.get(f.chat.id);
  f.service.cancel(
    f.chat.id,
    state.pending[0].id,
    { expectedRevision: state.revision, branchId: state.branchId, operationId: randomUUID() },
    authority
  );
  expect(run(f).run.snapshot.profile!.chatOptions!.values).toEqual({ tone: 'calm', detail: 1 });
});
test('helper option tools require the running host task and its direct or persistent grant, never model-supplied permission', () => {
  const f = fixture(),
    grant = delegate(f),
    workspace = new HelperWorkspace(f.store);
  const connection = f.store.product.connection({
    title: 'Local',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = f.store.product.model({
    title: 'Local',
    connectionId: connection.id,
    modelId: 'fixture-helper',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const conversation = workspace.conversation(grant.conversationId),
    requestKey = randomUUID();
  const task = workspace.enqueue(conversation.id, requestKey, '옵션을 골라줘', {
    scope: conversation.scope,
    model: f.store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    grants: chatOptionGrants(f.store, conversation.id, requestKey),
    limits: { totalCalls: 3, helperCalls: 3, artifacts: 0 },
  });
  const state = f.service.get(f.chat.id),
    args = {
      ...input(f, { detail: 5 }),
      expectedHeadRevision: state.headRevision,
      delegationId: grant.id,
    };
  const { branchId: _branchId, ...toolArgs } = args;
  expect(() => invokeHelperOptions(f.store, task, 'options.choose', toolArgs)).toThrow(/ACTIVE/);
  workspace.start(task.id, 'test-owner');
  const current = workspace.task(task.id);
  expect(invokeHelperOptions(f.store, current, 'options.read', {})).toMatchObject({ pending: [] });
  const modelRead = invokeHelperOptions(f.store, current, 'options.read', {});
  expect(modelRead).not.toHaveProperty('program');
  expect(modelRead).toMatchObject({
    definitions: state.program.controls,
    revision: state.revision,
    binding: state.binding,
    headRevision: state.headRevision,
    globalValues: state.globalValues,
    fixedValues: state.fixedValues,
    delegations: state.delegations,
    conflicts: state.conflicts,
  });
  expect(f.service.get(f.chat.id).program).toEqual(state.program);
  expect(() =>
    invokeHelperOptions(f.store, current, 'options.oneoff', {
      ...toolArgs,
      delegationId: undefined,
    })
  ).toThrow();
  expect(() =>
    invokeHelperOptions(
      f.store,
      {
        ...current,
        snapshot: {
          ...current.snapshot,
          scope: { kind: 'chat', chatId: 'foreign', branchId: 'foreign' },
        },
      } as HelperTask,
      'options.choose',
      toolArgs
    )
  ).toThrow(/scope/);
  const choiceReceipt = invokeHelperOptions(f.store, current, 'options.choose', toolArgs);
  expect(choiceReceipt).toMatchObject({
    pending: [expect.objectContaining({ values: { detail: 5 } })],
  });
  expect(choiceReceipt).not.toHaveProperty('program');
  expect(choiceReceipt).not.toHaveProperty('pending.0.delegation');
  expect(choiceReceipt).toMatchObject({
    pending: [
      { delegationId: grant.id, binding: state.binding, definitions: state.program.controls },
    ],
    delegations: [expect.objectContaining({ id: grant.id, revokedAt: null })],
  });
  const staged = f.service.get(f.chat.id);
  expect(staged.pending[0].delegation).toEqual(grant);
  f.service.revoke(
    f.chat.id,
    grant.id,
    { branchId: staged.branchId, expectedRevision: staged.revision, operationId: randomUUID() },
    authority
  );
  expect(() =>
    invokeHelperOptions(f.store, current, 'options.choose', {
      ...toolArgs,
      expectedRevision: f.service.get(f.chat.id).revision,
      operationId: randomUUID(),
    })
  ).toThrow(/위임/);
  // An explanation EOF does not undo the staged choice, even though this tool bypasses
  // helper_operations. A new whole-request retry must not stage it again.
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations').get()).toEqual({ n: 0 });
  workspace.finish(task.id, 'test-owner', current.generation, 'failed', '', 'UNEXPECTED_EOF');
  expect(workspace.task(task.id)).toMatchObject({
    completedEffects: { count: 1, labels: ['채팅 옵션'] },
  });
  expect(() =>
    workspace.enqueue(conversation.id, 'retry-option', task.request, {
      ...task.snapshot,
      retryOf: task.id,
    })
  ).toThrow('HELPER_EFFECTS_ALREADY_COMMITTED');
});
test('archive retains delegation start and revoke history, consumed option ownership and copied Run evidence without copying permission', () => {
  const f = fixture(),
    grant = delegate(f);
  stage(f, { detail: 6 }, grant.id);
  stage(f, { tone: 'warm' });
  const value = run(f).run,
    source = complete(f, value.id);
  const state = f.service.get(f.chat.id);
  f.service.revoke(
    f.chat.id,
    grant.id,
    { branchId: state.branchId, expectedRevision: state.revision, operationId: randomUUID() },
    authority
  );
  validateChatOptionArchive(f.store);
  const fork = forkChat(f.store, f.chat.id, {
    fromRevision: source.id,
    title: 'Forked options',
    idempotencyKey: randomUUID(),
  });
  const forked = f.store.run(f.store.source(fork.headRevision!).runId);
  expect(forked.snapshot.profile!.chatOptions!.values).toEqual(
    value.snapshot.profile!.chatOptions!.values
  );
  expect(forked.snapshot.profile!.chatOptions!.pendingIds).not.toEqual(
    value.snapshot.profile!.chatOptions!.pendingIds
  );
  expect(f.service.get(fork.id).pending).toEqual([]);
  expect(f.service.get(fork.id).delegations).toEqual([]);
  validateChatOptionArchive(f.store);
  const target = database();
  target.product.import(f.store.product.export());
  validateChatOptionArchive(target);
  const row = target.db
    .prepare('SELECT body FROM chat_option_pending WHERE id=?')
    .get(value.snapshot.profile!.chatOptions!.pendingIds[0])!;
  const corrupted = { ...JSON.parse(String(row.body)), chatId: fork.id };
  target.db
    .prepare('UPDATE chat_option_pending SET body=? WHERE id=?')
    .run(JSON.stringify(corrupted), corrupted.id);
  expect(() => validateChatOptionArchive(target)).toThrow(/identity|owner/);
});

test('the frozen profile owner and the live option binding come from one rule', () => {
  const workspace = defaultPromptWorkspace();
  expect(freezeCurrentPrompts(workspace).promptOptionOwner).toBe('workspace:main');
  expect(optionBinding(workspace.main).owner).toBe('workspace:main');
  const applied = { ...workspace, main: { ...workspace.main, presetId: 'preset-1' } };
  expect(freezeCurrentPrompts(applied).promptOptionOwner).toBe('preset:preset-1');
  expect(optionBinding(applied.main).owner).toBe('preset:preset-1');
});
