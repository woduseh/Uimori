import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { createBackupRemap } from '../server/chat-backup-remap.js';
import { remapChatBackupHelper } from '../server/chat-backup-helper.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { ChatOptionsStore } from '../server/chat-options.js';
import { ChatOverridesStore } from '../server/chat-overrides.js';
import { chatOverrideHash } from '../core/chat-overrides.js';
import { EditDraftService } from '../server/edit-drafts.js';
import { HelperWorkspace, directHelperGrants } from '../server/helper-workspace.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import type { Content } from '../core/product.js';
import type { PendingChatOptions } from '../core/chat-options.js';
import type { WorkspaceDraftModel } from '../core/edit-drafts.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  for (const { store, path } of owned.splice(0)) {
    store.close();
    const inside = relative(tmpdir(), path);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-backup-helper-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-backup-helper-'));
  const store = new Store(join(path, 'story.sqlite'));
  owned.push({ store, path });
  return store;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('multiple same-branch sessions and detached revoked option receipts survive repeated chat backup restoration', () => {
  const source = database(),
    chat = createFixtureChat(source, '복수 세션 백업');
  const prior = promptWorkspace(source);
  updatePromptWorkspace(source, {
    expectedRevision: prior.revision,
    main: {
      ...prior.main,
      values: { detail: 1 },
      program: {
        ...createDefaultPromptProgram(DEFAULT_MAIN_PROMPT),
        controls: [{ id: 'detail', label: 'Detail', type: 'number', default: 1, min: 0, max: 10 }],
      },
    },
  });
  const connection = source.product.connection({
    title: 'Fixture',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = source.product.model({
    title: 'Fixture',
    connectionId: connection.id,
    modelId: 'fixture',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const helper = new HelperWorkspace(source),
    branchId = source.product.branch(chat.id).id;
  const scope = { kind: 'chat' as const, chatId: chat.id, branchId };
  for (const title of ['세계관 검토', '다음 장면']) {
    const session = helper.create(scope, title, title);
    const task = helper.enqueue(session.id, 'same-key', `${title} 전용 질문`, {
      scope,
      model: source.product.modelSnapshot(model.id),
      history: [],
      persona: title,
      grants: [],
      limits: { totalCalls: 3, helperCalls: 3, artifacts: 1 },
    });
    helper.start(task.id, 'fixture');
    helper.finish(task.id, 'fixture', 1, 'completed', `${title} 전용 답변`, null);
  }
  const deleted = helper.create(scope, 'deleted', '삭제할 세션');
  const options = new ChatOptionsStore(source),
    state = options.get(chat.id);
  const delegated = options.delegate(
    chat.id,
    {
      branchId,
      conversationId: deleted.id,
      expectedRevision: state.revision,
      binding: state.binding,
      fields: ['detail'],
      operationId: 'delegate',
    },
    { requestId: 'user', assert: () => {} }
  );
  options.stage(
    chat.id,
    {
      branchId,
      expectedRevision: delegated.revision,
      binding: state.binding,
      values: { detail: 4 },
      expectedHeadRevision: state.headRevision,
      delegationId: delegated.delegations[0].id,
      operationId: 'choose',
    },
    { requestId: 'user', assert: () => {} },
    true
  );
  const command = {
    request: '옵션을 적용한 본편',
    expectedRevision: state.headRevision,
    expectedSettingsRevision: chat.settingsRevision,
    branchId,
    idempotencyKey: 'consume-options',
  };
  const written = source.createRun(chat.id, command, (current) => {
    const profile = source.product.snapshot(chat.id);
    return {
      chatId: chat.id,
      parentRevision: command.expectedRevision,
      settings: current.settings,
      settingsRevision: current.settingsRevision,
      request: command.request,
      history: source.history(command.expectedRevision),
      resources: source.product.resources(chat.id, profile),
      profile,
    };
  }).run;
  source.startRun(written.id);
  source.completeRun(
    written.id,
    '보존할 본편 원문',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    { ...written.snapshot.settings, status: false }
  );
  const nextOptions = options.get(chat.id);
  options.stage(
    chat.id,
    {
      branchId,
      expectedRevision: nextOptions.revision,
      binding: nextOptions.binding,
      values: { detail: 8 },
      expectedHeadRevision: nextOptions.headRevision,
      delegationId: delegated.delegations[0].id,
      operationId: 'unconsumed-choice',
    },
    { requestId: 'user', assert: () => {} },
    true
  );
  const runtime = new HelperRuntime(source, {
    approvedOrigins: [],
    owner: 'fixture',
    signal: new AbortController().signal,
    track: () => {
      throw new Error('No provider execution expected');
    },
    streams: new ResponseStreamStore(source),
  });
  runtime.deleteConversation(deleted.id, runtime.deletionImpact(deleted.id).request);
  const backup = exportChatBackup(source, chat.id),
    destination = database();
  expect(backup.records.helperConversations).toHaveLength(2);
  expect(backup.records.helperDelegations).toHaveLength(1);
  expect(backup.records.helperDelegations[0].conversationId).toBeNull();
  const first = importChatBackup(destination, { backup, idempotencyKey: 'one' });
  const second = importChatBackup(destination, { backup, idempotencyKey: 'two' });
  for (const imported of [first, second]) {
    const copies = new HelperWorkspace(destination).list({
      kind: 'chat',
      chatId: imported.chat.id,
    });
    expect(copies.map((item) => item.title).sort()).toEqual(['다음 장면', '세계관 검토']);
    for (const copy of copies) {
      expect(
        new HelperWorkspace(destination).messages(copy.id).map((message) => message.text)
      ).toEqual([`${copy.title} 전용 질문`, `${copy.title} 전용 답변`]);
      expect(copy.scope).toMatchObject({ chatId: imported.chat.id });
    }
    expect(new ChatOptionsStore(destination).get(imported.chat.id)).toMatchObject({
      pending: [],
      delegations: [],
    });
    const importedSource = destination.source(imported.chat.headRevision!);
    expect(importedSource.text).toBe('보존할 본편 원문');
    expect(destination.run(importedSource.runId).snapshot.profile?.chatOptions?.values).toEqual({
      detail: 4,
    });
    const roundtrip = exportChatBackup(destination, imported.chat.id);
    expect(roundtrip.records.helperDelegations).toHaveLength(1);
    expect(roundtrip.records.helperDelegations[0].conversationId).toBeNull();
    expect(() =>
      importChatBackup(database(), { backup: roundtrip, idempotencyKey: 'again' })
    ).not.toThrow();
  }
});

test('helper backup remaps durable draft and option ownership while preserving all authored payloads', () => {
  const store = database(),
    chat = createFixtureChat(store, '백업 원본');
  const saved = store.product.content(fixtureBotInput('Shared', chat.id)) as Content;
  const drafts = new EditDraftService(store);
  const draft = drafts.create(
    {
      editorKey: `content:${saved.id}`,
      kind: 'content',
      targetId: saved.id,
      model: fixtureBotInput('unused'),
      operationId: randomUUID(),
    },
    { requestId: 'user-ui', assert: () => {} }
  );
  const connection = store.product.connection({
    title: 'Synthetic',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic',
    connectionId: connection.id,
    modelId: 'fixture',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const helper = new HelperWorkspace(store);
  const conversation = helper.open({ kind: 'chat', chatId: chat.id, branchId: `main:${chat.id}` });
  const task = helper.enqueue(conversation.id, 'request', '현재 초안을 수정하고 저장해줘', {
    scope: conversation.scope,
    model: store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    grants: directHelperGrants('request', conversation.scope, '현재 초안을 수정하고 저장해줘', {
      draftId: draft.id,
    }),
    editor: { draftId: draft.id, revision: draft.revision, title: '현재 자료', kind: 'content' },
    limits: { totalCalls: 3, helperCalls: 3, artifacts: 1 },
  });
  helper.start(task.id, 'synthetic');
  const authority = { requestId: task.id, assert: () => {} };
  const patched = drafts.patch(
    draft.id,
    {
      expectedRevision: draft.revision,
      operationId: `${task.id}:patch`,
      model: { ...draft.model, title: chat.id },
      rawFields: {},
      unappliedFields: [],
    },
    authority
  );
  drafts.save(
    draft.id,
    { expectedRevision: patched.draft.revision, operationId: `${task.id}:save` },
    authority
  );
  const current = promptWorkspace(store);
  updatePromptWorkspace(store, {
    expectedRevision: current.revision,
    main: {
      ...current.main,
      values: { custom: chat.id },
      program: {
        ...createDefaultPromptProgram(DEFAULT_MAIN_PROMPT),
        controls: [{ id: 'custom', label: 'Custom', type: 'text', default: chat.id }],
      },
    },
  });
  const options = new ChatOptionsStore(store),
    state = options.get(chat.id);
  const staged = options.stage(
    chat.id,
    {
      branchId: state.branchId,
      expectedRevision: state.revision,
      binding: state.binding,
      values: { custom: chat.id },
      expectedHeadRevision: state.headRevision,
      operationId: 'option-write',
    },
    authority
  );
  const delegated = options.delegate(
    chat.id,
    {
      branchId: state.branchId,
      expectedRevision: staged.revision,
      binding: state.binding,
      fields: ['custom'],
      operationId: 'delegate-custom',
    },
    { requestId: 'user-ui-delegation', assert: () => {} }
  );
  helper.event(conversation.id, task.id, 'tool.finished', {
    name: 'options.oneoff',
    denied: false,
    result: delegated,
  });
  helper.finish(task.id, 'synthetic', 1, 'failed', '', 'UNEXPECTED_EOF');

  const archive = store.product.export();
  const before = structuredClone(archive.tables);
  const mapped = createBackupRemap(archive.tables, { helper_events: 10 });
  remapChatBackupHelper(mapped);
  // This fixture has no Run or context snapshots; the core profile ownership is the only
  // non-helper JSON dependency needed to exercise the real archive validators here.
  for (const row of mapped.tables.profiles)
    row.body = JSON.stringify(mapped.structured(JSON.parse(row.body)));
  const target = database();
  target.product.import({ ...archive, tables: mapped.tables });
  const restored = new HelperWorkspace(target).task(mapped.id(task.id));
  expect(restored.completedEffects).toEqual({
    count: 3,
    labels: ['자료 저장', '초안 수정', '채팅 옵션'],
  });
  expect(restored.request).toBe(task.request);
  expect(restored.snapshot.editor?.draftId).toBe(mapped.id(draft.id));
  const restoredDraft = new EditDraftService(target).get(mapped.id(draft.id));
  expect(restoredDraft.model).toEqual(drafts.get(draft.id).model);
  expect(restoredDraft.editorKey).toMatch(new RegExp(`^backup:${mapped.chatId}:`));
  expect(restoredDraft.targetId).toBe(saved.id);
  expect(new ChatOptionsStore(target).get(mapped.chatId).pending[0].values).toEqual({
    custom: chat.id,
  });
  expect(new ChatOptionsStore(target).get(mapped.chatId).delegations[0]).toMatchObject({
    id: mapped.id(delegated.delegations[0].id),
    conversationId: mapped.id(conversation.id),
    scope: { kind: 'chat', chatId: mapped.chatId, branchId: `main:${mapped.chatId}` },
  });
  expect(mapped.tables.chat_option_operations[0].command_hash).toBe(
    hash(JSON.parse(mapped.tables.chat_option_operations[0].command))
  );
  expect(mapped.tables.edit_draft_operations.map((row) => row.request_hash)).toEqual(
    before.edit_draft_operations.map((row) => row.request_hash)
  );
  expect(archive.tables).toEqual(before);
  const second = createBackupRemap(archive.tables);
  remapChatBackupHelper(second);
  expect(second.tables.edit_drafts[0].editor_key).not.toBe(mapped.tables.edit_drafts[0].editor_key);
});

test('lore backup retains shared selectors and text while remapping its local mutation receipt', () => {
  const store = database(),
    input = fixtureBotInput('Lore owner');
  input.package.lore = [
    { id: 'fact', title: 'Fact', description: '', text: 'Original lore', loading: 'pinned' },
  ];
  const bot = store.product.content(input) as Content;
  const chat = createFixtureChat(store, 'Lore backup', 'calm', { botId: bot.id });
  const lore = new ChatOverridesStore(store),
    state = lore.get(chat.id);
  const saved = lore.patch(
    chat.id,
    {
      selector: { id: bot.id, role: 'bot', modulePath: [], loreId: 'fact', field: 'text' },
      value: chat.id,
      branchId: state.branchId,
      expectedRevision: state.revision,
      expectedHeadRevision: state.headRevision,
      expectedProfileRevision: state.profileRevision,
      expectedPackageRevision: state.attachments[0].packageRevision,
      expectedFieldHash: chatOverrideHash('Original lore'),
      operationId: 'lore-write',
    },
    { requestId: 'user-ui-lore', assert: () => {} }
  );
  const archive = store.product.export(),
    mapped = createBackupRemap(archive.tables);
  remapChatBackupHelper(mapped);
  for (const row of mapped.tables.profiles)
    row.body = JSON.stringify(mapped.structured(JSON.parse(row.body)));
  const target = database();
  target.product.import({ ...archive, tables: mapped.tables });
  const restored = new ChatOverridesStore(target).get(mapped.chatId).overrides[0];
  expect(restored).toEqual({
    ...saved.entry,
    id: mapped.id(saved.entry.id),
    chatId: mapped.chatId,
  });
  expect(restored.value).toBe(chat.id);
  expect(mapped.tables.chat_override_operations[0].command_hash).toBe(
    archive.tables.chat_override_operations[0].command_hash
  );
});

test('fork pending identities are derived before helper snapshot references are remapped', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Fork metadata');
  const archive = store.product.export();
  const original: PendingChatOptions = {
    id: 'original-pending',
    chatId: chat.id,
    branchId: `main:${chat.id}`,
    kind: 'oneoff',
    binding: { owner: 'workspace:main', definitionHash: 'unchanged' },
    values: { user: chat.id },
    headRevision: null,
    headHash: null,
    status: 'consumed',
    runId: 'original-run',
    createdAt: new Date().toISOString(),
    definitions: [],
    origin: {
      pendingId: 'external-pending',
      chatId: 'external-chat',
      branchId: 'external-branch',
      runId: 'external-run',
    },
  };
  archive.tables.chat_option_pending.push({
    id: original.id,
    chat_id: chat.id,
    branch_id: original.branchId,
    body: JSON.stringify(original),
  });
  const mapped = createBackupRemap(archive.tables);
  remapChatBackupHelper(mapped);
  const expected = `fork-option:${hash({ chatId: mapped.chatId, pendingId: 'external-pending' }).slice(0, 48)}`;
  const row = mapped.tables.chat_option_pending[0];
  expect(row.id).toBe(expected);
  expect(mapped.id(original.id)).toBe(expected);
  expect(JSON.parse(row.body)).toMatchObject({
    id: expected,
    chatId: mapped.chatId,
    values: original.values,
    origin: original.origin,
  });
});

test('a high-revision global prompt draft stays detached through import and re-export until explicit rebase', () => {
  const source = database(),
    chat = createFixtureChat(source, 'Workspace draft backup');
  for (let step = 0; step < 4; step++) {
    const current = promptWorkspace(source);
    updatePromptWorkspace(source, {
      expectedRevision: current.revision,
      main: { ...current.main, title: `Source ${step}` },
    });
  }
  const drafts = new EditDraftService(source),
    authority = { requestId: 'user-ui', assert: () => {} };
  const opened = drafts.create(
    {
      kind: 'prompt-workspace',
      targetId: 'current',
      editorKey: 'prompt-workspace:current',
      model: {},
      operationId: randomUUID(),
    },
    authority
  );
  const saved = drafts.save(
    opened.id,
    { expectedRevision: opened.revision, operationId: randomUUID() },
    authority
  );
  const edited = drafts.patch(
    opened.id,
    {
      expectedRevision: saved.draft.revision,
      operationId: randomUUID(),
      model: {
        ...saved.draft.model,
        main: { ...(saved.draft.model as WorkspaceDraftModel).main, title: 'Preserved user draft' },
      },
      rawFields: { 'main.program': '{ incomplete' },
      unappliedFields: ['main.program'],
    },
    authority
  ).draft;
  const connection = source.product.connection({
    title: 'Fixture',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = source.product.model({
    title: 'Fixture',
    connectionId: connection.id,
    modelId: 'fixture',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const helper = new HelperWorkspace(source),
    conversation = helper.open({ kind: 'chat', chatId: chat.id, branchId: `main:${chat.id}` });
  const task = helper.enqueue(conversation.id, 'request', '초안을 검토해줘', {
    scope: conversation.scope,
    model: source.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    grants: [],
    editor: {
      draftId: edited.id,
      revision: edited.revision,
      title: 'Prompt draft',
      kind: 'prompt-workspace',
    },
    limits: { totalCalls: 3, helperCalls: 3, artifacts: 1 },
  });
  helper.start(task.id, 'fixture');
  helper.finish(task.id, 'fixture', 1, 'completed', '검토 완료', null);
  const destination = database(),
    originalGlobal = promptWorkspace(destination);
  expect(edited.baseRevision).toBeGreaterThan(originalGlobal.revision);
  const imported = importChatBackup(destination, {
    backup: exportChatBackup(source, chat.id),
    idempotencyKey: 'import-workspace',
  });
  const service = new EditDraftService(destination),
    restored = service.list().find((draft) => draft.backupOrigin?.chatId === imported.chat.id)!;
  expect(restored).toMatchObject({
    baseRevision: edited.baseRevision,
    baseModel: edited.baseModel,
    baseHash: edited.baseHash,
    model: edited.model,
    rawFields: edited.rawFields,
    unappliedFields: edited.unappliedFields,
  });
  expect(promptWorkspace(destination)).toEqual(originalGlobal);
  expect(() => exportChatBackup(destination, imported.chat.id)).not.toThrow();
  expect(() =>
    service.save(
      restored.id,
      { expectedRevision: restored.revision, operationId: 'blocked-save' },
      authority
    )
  ).toThrow('DRAFT_BACKUP_REBASE_REQUIRED');
  expect(() =>
    service.undo(
      restored.id,
      {
        expectedRevision: restored.revision,
        operationId: 'blocked-undo',
        savedOperationId: service.savedOperations(restored.id)[0].operationId,
      },
      authority
    )
  ).toThrow('DRAFT_BACKUP_REBASE_REQUIRED');
  expect(() =>
    service.rebase(
      restored.id,
      {
        expectedRevision: restored.revision,
        expectedTargetRevision: originalGlobal.revision,
        operationId: 'blocked-auto-rebase',
        mode: 'pristine',
      },
      authority
    )
  ).toThrow('DRAFT_BACKUP_REBASE_REQUIRED');
  const rebound = service.rebase(
    restored.id,
    {
      expectedRevision: restored.revision,
      expectedTargetRevision: originalGlobal.revision,
      operationId: 'explicit-rebase',
      mode: 'keep-draft',
    },
    authority
  );
  expect(rebound).not.toHaveProperty('backupOrigin');
  expect(rebound.model).toEqual(edited.model);
  expect(rebound.rawFields).toEqual(edited.rawFields);
  expect(rebound.baseRevision).toBe(originalGlobal.revision);
  expect(promptWorkspace(destination)).toEqual(originalGlobal);
  const applied = service.patch(
    rebound.id,
    {
      expectedRevision: rebound.revision,
      operationId: 'apply-buffer',
      model: rebound.model,
      rawFields: {},
      unappliedFields: [],
    },
    authority
  ).draft;
  expect(
    service.save(
      applied.id,
      { expectedRevision: applied.revision, operationId: 'save-rebased' },
      authority
    ).status
  ).toBe('saved');
  expect(promptWorkspace(destination).main.title).toBe('Preserved user draft');
  expect(() => exportChatBackup(destination, imported.chat.id)).not.toThrow();
});
