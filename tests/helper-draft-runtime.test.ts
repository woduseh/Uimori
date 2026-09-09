import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { EditDraftService } from '../server/edit-drafts.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { fixtureBotInput } from './fixtures/chat.js';
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
  requestKey = randomUUID()
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
  await vi.waitFor(() => expect(f.workspace.task(task.id).status).toBe('completed'), {
    timeout: 3000,
    interval: 10,
  });
  return { task: f.workspace.task(task.id), payload };
}

test('real app draft bridge reads the human buffer then honors one explicit patch and save despite a repeated save tool call', async () => {
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
  const completed = await submit(f, '현재 초안의 제목을 수정하고 미완성 JSON을 완성한 뒤 저장해줘');
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

test('a recommendation request cannot gain patch or save authority through model tool arguments in the real bridge', async () => {
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
  const { task } = await submit(f, '이 자료를 어떻게 수정하면 좋을까? 제안만 해줘');
  expect(task.snapshot.grants).toEqual([]);
  expect(f.drafts.get(f.draft.id)).toEqual(f.draft);
  expect(f.drafts.savedOperations(f.draft.id)).toEqual([]);
  expect(f.drafts.proposals(f.draft.id)).toEqual([]);
  expect(f.store.product.get<Content>('content', f.saved.id)).toEqual(f.saved);
});

test('a human revision after helper read produces a conflict proposal and preserves the newest title and incomplete JSON', async () => {
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
    return { ...success, text: '사람이 변경한 최신 초안을 유지하고 제안을 남겼어요.' };
  });
  const { task } = await submit(f, '현재 초안의 제목을 수정하고 저장해줘');
  expect(task.snapshot.grants).toEqual([
    expect.objectContaining({ target: f.draft.id, actions: ['draft.patch', 'draft.save'] }),
  ]);
  expect(f.drafts.get(f.draft.id)).toEqual(newest);
  expect(f.drafts.proposals(f.draft.id)).toHaveLength(1);
  expect(f.drafts.savedOperations(f.draft.id)).toEqual([]);
  expect(f.store.product.get<Content>('content', f.saved.id)).toEqual(f.saved);
});
