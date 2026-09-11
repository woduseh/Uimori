import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { EditDraftService } from '../server/edit-drafts.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { helperWritingSnapshot } from '../server/helper-runtime.js';
import { readHelperChatContext } from '../server/helper-context.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import type { Content } from '../core/product.js';
import type {
  ContentDraftModel,
  DraftPatchResult,
  DraftSaveResult,
  EditDraft,
} from '../core/edit-drafts.js';
import type { HelperConversation, HelperTask } from '../core/helper.js';
import type { ToolEvent } from '../core/types.js';
import * as transport from '../core/transport.js';

const owned: { app: App; path: string }[] = [];
afterEach(async () => {
  for (const { app, path } of owned.splice(0)) {
    await app.close();
    const inside = relative(tmpdir(), path);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-helper-draft-'))
      throw new Error('Unsafe cleanup');
    rmSync(path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-draft-'));
  const app = await createApp({
    dbPath: join(path, 'test.sqlite'),
    buildId: 'helper-draft-integration',
    testMode: true,
    approvedOrigins: ['http://127.0.0.1:9'],
  });
  owned.push({ app, path });
  const store = app.store;
  const connection = store.product.connection({
    title: 'Synthetic helper only',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic helper only',
    connectionId: connection.id,
    modelId: 'fixture-helper',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: selected.routes,
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
  });
  const saved = store.product.content(
    fixtureBotInput('저장된 원래 제목', 'Preserved authored body')
  ) as Content;
  const opened = await app.inject({
    method: 'POST',
    url: '/api/helper/conversations',
    payload: { scope: { kind: 'library', workId: 'draft-integration' } },
  });
  expect(opened.statusCode).toBe(200);
  const conversation = opened.json<HelperConversation>();
  const created = await app.inject({
    method: 'POST',
    url: '/api/edit-drafts',
    payload: {
      editorKey: `content:${saved.id}`,
      kind: 'content',
      targetId: saved.id,
      model: fixtureBotInput(),
      operationId: randomUUID(),
    },
  });
  expect(created.statusCode).toBe(200);
  const initial = created.json<EditDraft>();
  const changed = await app.inject({
    method: 'PATCH',
    url: `/api/edit-drafts/${initial.id}`,
    payload: {
      expectedRevision: initial.revision,
      operationId: randomUUID(),
      model: { ...initial.model, title: '사람이 입력한 미저장 제목' },
      rawFields: { 'package.instructions': '[\n  ' },
      unappliedFields: ['package.instructions'],
    },
  });
  expect(changed.statusCode).toBe(200);
  const draft = changed.json<DraftPatchResult>().draft;
  return {
    app,
    store,
    saved,
    conversation,
    draft,
    drafts: new EditDraftService(store),
    workspace: new HelperWorkspace(store),
  };
}
const success: transport.ProviderResult = {
  status: 'completed',
  text: '실제 결과를 확인했어요.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 4, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
const asJson = (value: unknown): transport.Json =>
  JSON.parse(JSON.stringify(value)) as transport.Json;
function tool(id: string, name: string, args: Record<string, unknown>): transport.ProviderToolCall {
  return { id, name, arguments: asJson(args) as Record<string, transport.Json> };
}
function calls(...toolCalls: transport.ProviderToolCall[]): transport.ProviderResult {
  return { ...structuredClone(success), status: 'tool_calls', text: '', toolCalls };
}
function mockSend(
  action: (
    request: transport.ProviderRequest,
    round: number
  ) => transport.ProviderResult | Promise<transport.ProviderResult>
) {
  let round = 0;
  return vi
    .spyOn(transport, 'executeProvider')
    .mockImplementation(async (connection, request, options) => {
      expect(request.role).toBe('helper');
      transport.validateConnection(connection, options.approvedOrigins);
      options.beforeTurn?.();
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'POST',
        url: connection.endpoint,
        headers: {},
        body: asJson(request),
        bodySha256: 'synthetic',
        stablePrefixSha256: 'synthetic',
      });
      return action(request, round++);
    });
}
function result<T>(request: transport.ProviderRequest, callId: string): T {
  const event = (request.input.results as unknown as ToolEvent[]).find(
    (item) => item.callId === callId
  );
  expect(event, `result for ${callId}`).toBeDefined();
  expect(event!.denied).toBe(false);
  return event!.result as T;
}
async function submit(
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
  requestKey = randomUUID(),
  status: HelperTask['status'] = 'completed'
) {
  const payload = {
    requestKey,
    text,
    editor: {
      draftId: f.draft.id,
      revision: f.draft.revision,
      title: '현재 자료 편집기',
      kind: 'content',
    },
  };
  const response = await f.app.inject({
    method: 'POST',
    url: `/api/helper/conversations/${f.conversation.id}/messages`,
    payload,
  });
  expect(response.statusCode).toBe(200);
  const task = response.json<HelperTask>();
  await vi.waitFor(() => expect(f.workspace.task(task.id).status).toBe(status), {
    timeout: 3000,
    interval: 10,
  });
  return { task: f.workspace.task(task.id), payload };
}

test('real helper context reads keep one active summary and scoped notes without checkpoint or job history', async () => {
  const f = await fixture(),
    selected = modelWorkspace(f.store);
  updateModelWorkspace(f.store, {
    expectedRevision: selected.revision,
    routes: { ...selected.routes, main: selected.helperModel },
    translationPolicy: selected.translationPolicy,
  });
  const chat = createFixtureChat(f.store, 'Synthetic context read'),
    branch = f.store.product.branch(chat.id);
  for (let index = 0; index < 4; index++) {
    const current = f.store.chat(chat.id),
      request = `Synthetic request ${index}`;
    const run = f.store.createRun(
      chat.id,
      {
        request,
        expectedRevision: current.headRevision,
        expectedSettingsRevision: current.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      (captured) => ({
        chatId: chat.id,
        parentRevision: captured.headRevision,
        settingsRevision: captured.settingsRevision,
        settings: captured.settings,
        request,
        history: f.store.history(captured.headRevision),
        resources: [],
      })
    ).run;
    f.store.startRun(run.id);
    f.store.completeRun(
      run.id,
      `Synthetic source ${index}`,
      { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      run.snapshot.settings
    );
  }
  const notesBase = {
    branchId: branch.id,
    expectedHeadRevision: f.store.chat(chat.id).headRevision,
    author: 'Synthetic user',
  };
  const oldNote = f.store.story.notes.write(chat.id, {
    ...notesBase,
    expectedRevision: 0,
    idempotencyKey: 'original-note',
    text: 'REPLACED_NOTE',
  });
  const note = f.store.story.notes.write(chat.id, {
    ...notesBase,
    expectedRevision: oldNote.revision,
    idempotencyKey: 'corrected-note',
    replacesId: oldNote.note.id,
    text: 'The user correction takes precedence over derived summaries.',
  });
  const activeSummary = 'ACTIVE_SUMMARY: preserve the unresolved promise and its source.';
  for (let index = 0; index < 8; index++) {
    const snapshot = helperWritingSnapshot(f.store, chat.id, branch.id, 'context');
    f.store.context.edit(
      chat.id,
      {
        branchId: branch.id,
        expectedRevision: index,
        expectedHeadRevision: snapshot.parentRevision,
        idempotencyKey: `summary-${index}`,
        summary: index === 7 ? activeSummary : `ARCHIVED_SUMMARY_${index}: ${'old '.repeat(4000)}`,
      },
      snapshot
    );
  }
  const snapshot = helperWritingSnapshot(f.store, chat.id, branch.id, 'context');
  const job = f.store.context.schedule(
    chat.id,
    {
      branchId: branch.id,
      expectedRevision: 8,
      expectedHeadRevision: snapshot.parentRevision,
      idempotencyKey: 'cancelled-ui-job',
    },
    snapshot
  );
  f.store.context.cancel(chat.id, job.id);
  const beforeResponse = await f.app.inject(`/api/chats/${chat.id}/context`),
    before = beforeResponse.json();
  expect(beforeResponse.statusCode).toBe(200);
  expect(before.checkpoints).toHaveLength(8);
  expect(before.jobs).toHaveLength(1);
  expect(before.checkpoint.plan.compacted).toHaveLength(2);
  const conversation = f.workspace.open({ kind: 'chat', chatId: chat.id, branchId: branch.id });
  let read!: ReturnType<typeof readHelperChatContext>,
    events: ToolEvent[] = [];
  const send = mockSend((request, round) => {
    if (round === 0) return calls(tool('read-context', 'context.read', {}));
    if (round === 1) {
      read = result(request, 'read-context');
      return calls(
        tool('unauthorized-summary', 'context.edit', {
          expectedRevision: read.activeRevision,
          summary: 'UNAUTHORIZED_SUMMARY',
          operationId: 'unauthorized-summary',
        }),
        tool('unauthorized-note', 'notes.write', {
          body: { text: 'UNAUTHORIZED_NOTE', expectedRevision: read.notesRevision },
          operationId: 'unauthorized-note',
        })
      );
    }
    events = request.input.results as unknown as ToolEvent[];
    return structuredClone(success);
  });
  const { task } = await submit({ ...f, conversation }, '현재 요약과 사용자 정정을 읽고 설명해줘');
  expect(send).toHaveBeenCalledTimes(3);
  expect(task.snapshot.grants).toEqual([]);
  expect(read).toEqual({
    scopeKey: before.scopeKey,
    activeRevision: 8,
    notesRevision: note.revision,
    headRevision: snapshot.parentRevision,
    checkpoint: {
      id: before.checkpoint.id,
      revision: before.checkpoint.revision,
      hash: before.checkpoint.hash,
      origin: before.checkpoint.origin,
      plan: {
        summary: activeSummary,
        dependencyKey: before.checkpoint.plan.dependencyKey,
        compacted: before.checkpoint.plan.compacted,
        recentSourceRevisions: before.checkpoint.plan.recentSourceRevisions,
      },
    },
    usable: true,
    invalidReason: null,
    notes: [note.note],
  });
  const serialized = JSON.stringify(read);
  expect(serialized).not.toContain('ARCHIVED_SUMMARY_');
  expect(serialized).not.toContain('REPLACED_NOTE');
  expect(serialized.length).toBeLessThan(beforeResponse.body.length / 10);
  for (const name of ['context.edit', 'notes.write'])
    expect(events.find((event) => event.name === name)).toMatchObject({ denied: true });
  expect((await f.app.inject(`/api/chats/${chat.id}/context`)).json()).toEqual(before);
  expect(f.store.story.notes.revision(chat.id)).toBe(note.revision);
});

test('helper context reads preserve missing summaries and stale checkpoint usability with current CAS revisions', async () => {
  const f = await fixture(),
    selected = modelWorkspace(f.store);
  updateModelWorkspace(f.store, {
    expectedRevision: selected.revision,
    routes: { ...selected.routes, main: selected.helperModel },
    translationPolicy: selected.translationPolicy,
  });
  const chat = createFixtureChat(f.store, 'Synthetic stale summary'),
    branch = f.store.product.branch(chat.id);
  expect(readHelperChatContext(f.store, chat.id, branch.id)).toMatchObject({
    activeRevision: 0,
    notesRevision: 0,
    checkpoint: null,
    usable: false,
    invalidReason: null,
    notes: [],
  });
  const snapshot = helperWritingSnapshot(f.store, chat.id, branch.id, 'context');
  const saved = f.store.context.edit(
    chat.id,
    {
      branchId: branch.id,
      expectedRevision: 0,
      expectedHeadRevision: null,
      idempotencyKey: 'first-summary',
      summary: 'Saved summary before the user correction.',
    },
    snapshot
  );
  const note = f.store.story.notes.write(chat.id, {
    branchId: branch.id,
    expectedRevision: 0,
    expectedHeadRevision: null,
    idempotencyKey: 'new-correction',
    author: 'Synthetic user',
    text: 'The earlier summary has an incorrect promise.',
  });
  const read = readHelperChatContext(f.store, chat.id, branch.id);
  expect(read).toMatchObject({
    activeRevision: 1,
    notesRevision: 1,
    checkpoint: { id: saved.checkpoint!.id, plan: { summary: saved.checkpoint!.plan.summary } },
    usable: false,
    notes: [note.note],
  });
  expect(read.invalidReason).toBeTruthy();
});

test('the real draft bridge keeps saved writes visible after EOF and refuses a fresh whole-request retry', async () => {
  const f = await fixture();
  const send = mockSend((request, round) => {
    if (round === 0)
      return calls(
        tool('patch', 'draft.patch', {
          expectedRevision: f.draft.revision,
          model: { ...f.draft.model, title: '설명 실패 전에 저장한 제목' },
          rawFields: {},
          unappliedFields: [],
          operationId: 'patch-before-eof',
        })
      );
    if (round === 1)
      return calls(
        tool('save', 'draft.save', {
          expectedRevision: result<DraftPatchResult>(request, 'patch').draft.revision,
          operationId: 'save-before-eof',
        })
      );
    expect(result<DraftSaveResult>(request, 'save').status).toBe('saved');
    return { ...success, status: 'error', text: '', error: { code: 'UNEXPECTED_EOF' } };
  });
  const { task } = await submit(f, '현재 초안을 수정하고 저장해줘', randomUUID(), 'failed');
  expect(task.completedEffects).toEqual({ count: 2, labels: ['자료 저장', '초안 수정'] });
  expect(f.store.product.get<Content>('content', f.saved.id).title).toBe(
    '설명 실패 전에 저장한 제목'
  );
  const retry = await f.app.inject({
    method: 'POST',
    url: `/api/helper/conversations/${f.conversation.id}/messages`,
    payload: { requestKey: randomUUID(), text: task.request, retryOf: task.id },
  });
  expect(retry.statusCode).toBe(409);
  expect(retry.json()).toMatchObject({ error: 'HELPER_EFFECTS_ALREADY_COMMITTED' });
  expect(f.drafts.savedOperations(f.draft.id)).toHaveLength(1);
  expect(send).toHaveBeenCalledTimes(3);
});

test.each([
  '현재 초안의 제목을 수정해줘',
  '현재 초안의 제목을 수정하고 미완성 JSON을 완성한 뒤 저장해줘',
  '현재 초안의 제목을 수정하고 미완성 JSON을 완성한 뒤 저장해 주실 수 있을까요?',
])('real draft bridge completes clear edit or save requests exactly once: %s', async (text) => {
  const f = await fixture();
  let saveArgs: Record<string, unknown> | undefined, savedResult: DraftSaveResult | undefined;
  const send = mockSend((request, round) => {
    if (round === 0) return calls(tool('read', 'workspace.read', { kind: 'draft' }));
    if (round === 1) {
      const read = result<EditDraft>(request, 'read');
      expect(read.model).toMatchObject({ title: '사람이 입력한 미저장 제목' });
      expect(read.rawFields).toEqual({ 'package.instructions': '[\n  ' });
      expect(read.unappliedFields).toEqual(['package.instructions']);
      const model = read.model as ContentDraftModel;
      return calls(
        tool('patch', 'draft.patch', {
          expectedRevision: read.revision,
          model: {
            ...model,
            title: '도우미가 완성한 제목',
            package: { ...model.package, instructions: [] },
          },
          rawFields: { 'package.instructions': '[]' },
          unappliedFields: [],
          operationId: 'complete-requested-draft',
        })
      );
    }
    if (round === 2) {
      const patched = result<DraftPatchResult>(request, 'patch');
      expect(patched.status).toBe('applied');
      expect(f.store.product.get<Content>('content', f.saved.id)).toEqual(f.saved);
      saveArgs = { expectedRevision: patched.draft.revision, operationId: 'save-requested-draft' };
      return calls(tool('save', 'draft.save', saveArgs));
    }
    if (round === 3) {
      savedResult = result<DraftSaveResult>(request, 'save');
      expect(savedResult.status).toBe('saved');
      return calls(tool('repeat-save-new-call-id', 'draft.save', saveArgs!));
    }
    expect(round).toBe(4);
    expect(result<DraftSaveResult>(request, 'repeat-save-new-call-id')).toEqual(savedResult);
    return success;
  });
  const completed = await submit(f, text);
  expect(completed.task.snapshot.grants).toEqual([
    expect.objectContaining({
      target: f.draft.id,
      actions: ['draft.patch', 'draft.save'],
      provenance: 'direct-user-request',
    }),
  ]);
  expect(f.store.product.get<Content>('content', f.saved.id)).toMatchObject({
    title: '도우미가 완성한 제목',
    revision: f.saved.revision + 1,
    text: f.saved.text,
  });
  expect(f.drafts.savedOperations(f.draft.id)).toHaveLength(1);
  expect(f.drafts.get(f.draft.id).unappliedFields).toEqual([]);
  const replay = await f.app.inject({
    method: 'POST',
    url: `/api/helper/conversations/${f.conversation.id}/messages`,
    payload: completed.payload,
  });
  expect(replay.statusCode).toBe(200);
  expect(replay.json<HelperTask>().id).toBe(completed.task.id);
  expect(send).toHaveBeenCalledTimes(5);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
});

test.each([
  '이 자료를 어떻게 수정하면 좋을까? 제안만 해줘',
  '현재 프롬프트를 저장해도 괜찮은지 확인해줘.',
  '프롬프트를 수정해도 되는지 확인해줘.',
  '문제가 없으면 초안을 저장해줘.',
])('a review or conditional request cannot gain authority in the real bridge: %s', async (text) => {
  const f = await fixture();
  mockSend((request, round) => {
    if (round === 0) return calls(tool('read', 'workspace.read', { kind: 'draft' }));
    if (round === 1) {
      const read = result<EditDraft>(request, 'read');
      return calls(
        tool('unauthorized-patch', 'draft.patch', {
          expectedRevision: read.revision,
          model: { ...read.model, title: '권한 없는 변경' },
          rawFields: {},
          unappliedFields: [],
          operationId: 'unauthorized-patch',
          grant: { actions: ['draft.patch', 'draft.save'], provenance: 'direct-user-request' },
        }),
        tool('unauthorized-save', 'draft.save', {
          expectedRevision: read.revision,
          operationId: 'unauthorized-save',
        })
      );
    }
    const events = request.input.results as unknown as ToolEvent[];
    for (const callId of ['unauthorized-patch', 'unauthorized-save'])
      expect(events.find((item) => item.callId === callId)).toMatchObject({
        denied: true,
        result: { recoverable: true, error: expect.stringContaining('사용자 요청') },
      });
    return success;
  });
  const { task } = await submit(f, text);
  expect(task.snapshot.grants).toEqual([]);
  expect(f.drafts.get(f.draft.id)).toEqual(f.draft);
  expect(f.drafts.savedOperations(f.draft.id)).toEqual([]);
  expect(f.drafts.proposals(f.draft.id)).toEqual([]);
  expect(f.store.product.get<Content>('content', f.saved.id)).toEqual(f.saved);
});

test.each(['completed', 'failed'] as const)(
  'human revision conflicts preserve the draft and are not counted as applied writes: %s',
  async (status) => {
    const f = await fixture();
    let newest: EditDraft | undefined;
    mockSend(async (request, round) => {
      if (round === 0) return calls(tool('read', 'workspace.read', { kind: 'draft' }));
      if (round === 1) {
        const observed = result<EditDraft>(request, 'read');
        const response = await f.app.inject({
          method: 'PATCH',
          url: `/api/edit-drafts/${f.draft.id}`,
          payload: {
            expectedRevision: observed.revision,
            operationId: randomUUID(),
            model: { ...observed.model, title: '사람이 나중에 고친 제목' },
            rawFields: { 'package.instructions': '[\n  {"id":' },
            unappliedFields: ['package.instructions'],
          },
        });
        expect(response.statusCode).toBe(200);
        newest = response.json<DraftPatchResult>().draft;
        return calls(
          tool('stale-patch', 'draft.patch', {
            expectedRevision: observed.revision,
            model: { ...observed.model, title: '읽은 시점의 도우미 제안' },
            rawFields: observed.rawFields,
            unappliedFields: observed.unappliedFields,
            operationId: 'stale-proposal',
          })
        );
      }
      const patched = result<DraftPatchResult>(request, 'stale-patch');
      expect(patched.status).toBe('conflict');
      expect(patched.draft).toEqual(newest);
      if (patched.status === 'conflict')
        expect(patched.proposal).toMatchObject({
          expectedRevision: f.draft.revision,
          actualRevision: newest!.revision,
          model: { title: '읽은 시점의 도우미 제안' },
          rawFields: f.draft.rawFields,
        });
      return {
        ...success,
        status: status === 'failed' ? 'error' : 'completed',
        text: '사람이 변경한 최신 초안을 유지하고 제안을 남겼어요.',
        error: status === 'failed' ? { code: 'UNEXPECTED_EOF' } : null,
      };
    });
    const { task } = await submit(f, '현재 초안의 제목을 수정하고 저장해줘', randomUUID(), status);
    expect(task.snapshot.grants).toEqual([
      expect.objectContaining({ target: f.draft.id, actions: ['draft.patch', 'draft.save'] }),
    ]);
    expect(f.drafts.get(f.draft.id)).toEqual(newest);
    expect(f.drafts.proposals(f.draft.id)).toHaveLength(1);
    expect(f.drafts.savedOperations(f.draft.id)).toEqual([]);
    expect(f.store.product.get<Content>('content', f.saved.id)).toEqual(f.saved);
    expect(task).not.toHaveProperty('completedEffects');
  }
);

test('helper task projections retain the reserved model title after a rename and selection change without exposing snapshots', async () => {
  const f = await fixture();
  const send = mockSend(() => success);
  const original = await submit(f, '예약 당시 모델을 기록해줘');
  const model = original.task.snapshot.model;
  f.store.product.model(
    {
      expectedRevision: model.revision,
      title: '이름을 바꾼 이전 모델',
      connectionId: model.connectionId,
      modelId: model.modelId,
      temperature: model.temperature,
      maxOutputTokens: model.maxOutputTokens,
    },
    model.id
  );
  const selectedModel = f.store.product.model({
    title: '새로 선택한 도우미 모델',
    connectionId: model.connectionId,
    modelId: 'fixture-new-helper',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const selected = modelWorkspace(f.store);
  updateModelWorkspace(f.store, {
    expectedRevision: selected.revision,
    routes: selected.routes,
    translationPolicy: selected.translationPolicy,
    helperModel: { id: selectedModel.id },
  });
  const latest = await submit(f, '새 선택으로 작업해줘');
  const snapshots = () =>
    f.store.db.prepare('SELECT id,snapshot FROM helper_tasks ORDER BY rowid').all();
  const beforeReads = snapshots();
  const listed = await f.app.inject(`/api/helper/conversations/${f.conversation.id}/tasks`);
  expect(listed.statusCode).toBe(200);
  const tasks = listed.json<(Omit<HelperTask, 'snapshot'> & { modelTitle: string })[]>();
  expect(tasks.map((task) => [task.id, task.modelTitle])).toEqual([
    [latest.task.id, selectedModel.title],
    [original.task.id, model.title],
  ]);
  const detail = await f.app.inject(`/api/helper/tasks/${original.task.id}`);
  const replay = await f.app.inject({
    method: 'POST',
    url: `/api/helper/conversations/${f.conversation.id}/messages`,
    payload: original.payload,
  });
  for (const response of [detail, replay]) {
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: original.task.id, modelTitle: model.title });
  }
  for (const view of [...tasks, detail.json(), replay.json()]) {
    expect(view).not.toHaveProperty('snapshot');
    expect(view).not.toHaveProperty('model');
    expect(view).not.toHaveProperty('connection');
  }
  expect(f.workspace.task(original.task.id).snapshot).toEqual(original.task.snapshot);
  expect(snapshots()).toEqual(beforeReads);
  expect(send).toHaveBeenCalledTimes(2);
});
