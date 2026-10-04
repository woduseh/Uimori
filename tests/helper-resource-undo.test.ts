import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import type { HelperTask } from '../core/helper.js';
import { emptyIllustrationPreset } from '../core/illustration-presets.js';
import { editableResource } from '../core/resource-editing.js';
import { emptyTheme } from '../core/themes.js';
import * as transport from '../core/transport.js';
import { helperResourceOperation } from '../server/helper-resource-tools.js';
import {
  applyHelperResourceMutation,
  lastHelperResourceEdit,
  undoHelperResourceEdit,
} from '../server/helper-resource-undo.js';
import { helperRoutes } from '../server/helper-routes.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { putImageBlob } from '../server/package-images.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { readResource, saveResource } from '../server/resource-service.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: {
  store: Store;
  controller: AbortController;
  work: Promise<void>[];
  path: string;
  app: ReturnType<typeof Fastify>;
}[] = [];
afterEach(async () => {
  for (const f of owned.splice(0)) {
    f.controller.abort();
    await Promise.allSettled(f.work);
    await f.app.close();
    f.store.close();
    const inside = relative(tmpdir(), f.path);
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-helper-undo-'))
      throw new Error('Unsafe cleanup');
    rmSync(f.path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-undo-'));
  const store = new Store(join(path, 'test.sqlite'));
  const connection = store.product.connection({
    title: 'Synthetic helper',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic helper',
    connectionId: connection.id,
    modelId: 'synthetic-helper',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: { ...selected.routes, main: { id: model.id } },
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
  });
  const controller = new AbortController();
  const work: Promise<void>[] = [];
  const runtime = new HelperRuntime(store, {
    owner: 'test-owner',
    signal: controller.signal,
    track: (p) => work.push(p),
    streams: new ResponseStreamStore(store),
  });
  const workspace = runtime.workspace;
  const conversation = workspace.open({ kind: 'library', workId: 'resource-undo' });
  const app = Fastify();
  helperRoutes(app, runtime);
  const f = { store, workspace, runtime, conversation, model, controller, work, path, app };
  owned.push(f);
  return f;
}
type Fixture = ReturnType<typeof fixture>;
function queuedTask(f: Fixture, key = 'edit') {
  return f.workspace.enqueue(f.conversation.id, key, '자료를 고쳐줘', {
    scope: f.conversation.scope,
    model: f.store.product.modelSnapshot(f.model.id),
    history: [],
    persona: '',
    limits: { totalCalls: 24, helperCalls: 12, artifacts: 1 },
  });
}
function runningTask(f: Fixture, key = 'edit') {
  const task = queuedTask(f, key);
  expect(f.workspace.start(task.id, 'test-owner')).toBe(true);
  return task;
}
function mutate(
  f: Fixture,
  task: HelperTask,
  name: string,
  args: Record<string, unknown>,
  key: string
) {
  const operation = helperResourceOperation(name, args);
  if (!operation || operation.readOnly) throw new Error('Expected resource mutation');
  return f.workspace.operation(task.id, key, { name, args }, () =>
    applyHelperResourceMutation(f.store, f.workspace, task, key, name, args, operation.target)
  );
}
function finish(f: Fixture, task: HelperTask) {
  expect(f.workspace.finish(task.id, 'test-owner', 1, 'completed', '완료했어요.', null)).toBe(true);
}
const lastEdit = (f: Fixture) => lastHelperResourceEdit(f.store, f.workspace, f.conversation.id);
const patchTitle = (id: string, expectedRevision: number, title: string) => ({
  kind: 'content',
  id,
  expectedRevision,
  changes: [{ op: 'set', path: '/package/nativeRisu/card/name', value: title }],
});
const success: transport.ProviderResult = {
  status: 'completed',
  text: '완료했어요.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 4, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
function providerMutation(name: string, args: Record<string, unknown>, failAfterWrite = false) {
  let round = 0;
  vi.spyOn(transport, 'executeProvider').mockImplementation(
    async (connection, request, options): Promise<transport.ProviderResult> => {
      transport.validateConnection(connection);
      options.beforeTurn?.();
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'POST',
        url: connection.endpoint,
        headers: {},
        body: request as unknown as transport.Json,
        bodySha256: 'synthetic',
        stablePrefixSha256: 'synthetic',
      });
      if (round++ === 0)
        return {
          ...structuredClone(success),
          status: 'tool_calls',
          toolCalls: [
            {
              id: 'edit-resource',
              name: 'app.call',
              arguments: { name, arguments: args as Record<string, transport.Json> },
            },
          ],
        };
      return failAfterWrite
        ? {
            ...structuredClone(success),
            status: 'error',
            text: '',
            error: { code: 'UNEXPECTED_EOF' },
          }
        : structuredClone(success);
    }
  );
}

test('runtime edits stay undoable after input cleanup and duplicate POST confirms without another write', async () => {
  const f = fixture();
  const content = f.store.product.content(fixtureBotInput('원래 제목', '원본 보존'));
  providerMutation('resource.patch', patchTitle(content.id, content.revision, '고친 제목'));
  const task = f.runtime.enqueue(f.conversation.id, 'runtime-edit', '제목을 고쳐줘');
  await Promise.all(f.work);
  expect(f.workspace.task(task.id).status).toBe('completed');
  const event = f.workspace
    .events(f.conversation.id)
    .find((item) => item.kind === 'resource.edited')!;
  expect(event.data).toMatchObject({ id: content.id, revision: 2, title: '고친 제목' });
  expect(JSON.stringify(event.data)).not.toContain('원본 보존');
  const receiptId = (event.data as { receiptId: string }).receiptId;
  expect(
    JSON.parse(
      String(
        f.store.db.prepare('SELECT result FROM helper_operations WHERE id=?').get(receiptId)?.result
      )
    )
  ).toEqual({ detailsOmitted: true });
  const view = await f.app.inject(`/api/helper/conversations/${f.conversation.id}/view`);
  const edit = view.json().lastResourceEdit;
  expect(edit).toMatchObject({
    editSeq: event.seq,
    taskId: task.id,
    id: content.id,
    canUndo: true,
  });
  const post = (payload: object) =>
    f.app.inject({
      method: 'POST',
      url: `/api/helper/conversations/${f.conversation.id}/undo-resource`,
      payload,
    });
  expect((await post({ editSeq: edit.editSeq, id: 'arbitrary-target' })).statusCode).toBe(400);
  const response = await post({ editSeq: edit.editSeq });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ ...edit, canUndo: false, undone: true });
  const restored = readResource(f.store, 'content', content.id);
  expect(restored).toMatchObject({ title: '원래 제목', revision: 3 });
  // A dropped response retry must not undo a subsequent user's save or toggle the old version.
  saveResource(f.store, {
    kind: 'content',
    id: content.id,
    expectedRevision: 3,
    model: fixtureBotInput('사용자 후속 제목', '원본 보존'),
  });
  const duplicate = await post({ editSeq: edit.editSeq });
  expect(duplicate.json()).toEqual(response.json());
  expect(readResource(f.store, 'content', content.id)).toMatchObject({
    revision: 4,
    title: '사용자 후속 제목',
  });
  expect(lastEdit(f)).toEqual(response.json());
  expect(
    f.workspace.events(f.conversation.id).filter((item) => item.kind === 'resource.edit.undone')
  ).toHaveLength(1);
});

test.each(['theme', 'illustration-preset'] as const)(
  'failed explanation keeps %s save recoverable and refresh events survive undo',
  async (kind) => {
    const f = fixture();
    const model = kind === 'theme' ? emptyTheme('원래 설정') : emptyIllustrationPreset('원래 설정');
    const saved = saveResource(f.store, { kind, id: null, model }).saved;
    if (!('id' in saved)) throw new Error('Expected saved ID');
    providerMutation(
      'resource.save',
      {
        kind,
        id: saved.id,
        expectedRevision: saved.revision,
        model: { ...model, title: '변경한 설정' },
      },
      true
    );
    const task = f.runtime.enqueue(f.conversation.id, 'failed-explanation', '설정 이름을 바꿔줘');
    await Promise.all(f.work);
    expect(f.workspace.task(task.id)).toMatchObject({
      status: 'failed',
      completedEffects: { count: 1 },
    });
    const edit = lastEdit(f)!;
    expect(edit).toMatchObject({ kind, id: saved.id, canUndo: true });
    undoHelperResourceEdit(f.store, f.workspace, f.conversation.id, edit.editSeq);
    expect(readResource(f.store, kind, saved.id)).toMatchObject({ title: '원래 설정' });
    const kinds = f.workspace.events(f.conversation.id).map((event) => event.kind);
    expect(kinds.filter((value) => value === `${kind}.updated`)).toHaveLength(2);
    expect(kinds.filter((value) => value === 'resource.updated')).toHaveLength(2);
  }
);

test.each([
  'external-save',
  'missing-undo',
  'deleted',
  'missing-receipt',
  'queued',
  'running',
] as const)('latest edit stays selected and undo rechecks %s', (blocker) => {
  const f = fixture();
  const task = runningTask(f);
  const contents = ['처음 자료', '최근 자료'].map((title) =>
    f.store.product.content(fixtureBotInput(title))
  );
  for (const content of contents)
    mutate(
      f,
      task,
      'resource.patch',
      patchTitle(content.id, content.revision, `${content.title} 수정`),
      content.id
    );
  finish(f, task);
  const edit = lastEdit(f)!;
  const content = contents[1];
  expect(edit).toMatchObject({ id: content.id, canUndo: true });
  if (blocker === 'external-save') {
    const saved = readResource(f.store, 'content', content.id);
    saveResource(f.store, {
      kind: 'content',
      id: content.id,
      expectedRevision: saved.revision,
      model: { ...editableResource('content', saved), description: '다른 창 수정' },
    });
  } else if (blocker === 'missing-undo') {
    f.store.db
      .prepare('DELETE FROM resource_undo WHERE kind=? AND id=?')
      .run('content', content.id);
  } else if (blocker === 'deleted') {
    const deleting = runningTask(f, 'delete');
    mutate(
      f,
      deleting,
      'resource.delete',
      { kind: 'content', id: content.id, expectedRevision: edit.revision },
      'delete'
    );
    finish(f, deleting);
  } else if (blocker === 'missing-receipt') {
    f.store.db.prepare('DELETE FROM helper_operations WHERE id=?').run(content.id);
  } else if (blocker === 'queued') queuedTask(f, 'new-task');
  else runningTask(f, 'new-task');
  expect(lastEdit(f)).toMatchObject({
    editSeq: edit.editSeq,
    id: content.id,
    canUndo: false,
    reason: expect.any(String),
  });
  expect(() =>
    undoHelperResourceEdit(f.store, f.workspace, f.conversation.id, edit.editSeq)
  ).toThrow();
  const firstSeq = f.workspace
    .events(f.conversation.id)
    .find((event) => event.kind === 'resource.edited')!.seq;
  expect(() => undoHelperResourceEdit(f.store, f.workspace, f.conversation.id, firstSeq)).toThrow(
    '최근 수정이 바뀌었어요'
  );
  expect(readResource(f.store, 'content', contents[0].id)).toMatchObject({
    title: '처음 자료 수정',
    revision: 2,
  });
});

test('new resources, unchanged writes and resource undo never become another recoverable edit', () => {
  const f = fixture();
  const task = runningTask(f);
  const created = mutate(
    f,
    task,
    'resource.save',
    { kind: 'theme', model: emptyTheme('새 테마') },
    'create'
  ) as { id: string; revision: number };
  expect(lastEdit(f)).toBeNull();
  const before = readResource(f.store, 'theme', created.id);
  mutate(
    f,
    task,
    'resource.save',
    {
      kind: 'theme',
      id: created.id,
      expectedRevision: before.revision,
      model: editableResource('theme', before),
    },
    'noop-save'
  );
  expect(lastEdit(f)).toBeNull();
  const content = f.store.product.content(fixtureBotInput('제목'));
  mutate(f, task, 'resource.patch', patchTitle(content.id, content.revision, '제목'), 'noop-patch');
  expect(lastEdit(f)).toBeNull();
  mutate(
    f,
    task,
    'resource.patch',
    patchTitle(content.id, content.revision, '새 제목'),
    'real-edit'
  );
  const editSeq = lastEdit(f)!.editSeq;
  mutate(
    f,
    task,
    'resource.undo',
    { kind: 'content', id: content.id, expectedRevision: 2 },
    'tool-undo'
  );
  finish(f, task);
  expect(lastEdit(f)).toMatchObject({ editSeq, canUndo: false });
  expect(
    f.workspace.events(f.conversation.id).filter((event) => event.kind === 'resource.edited')
  ).toHaveLength(1);
});

test('image metadata restores prior metadata without changing image bytes', () => {
  const f = fixture();
  const blob = putImageBlob(f.store.product, {
    mime: 'image/png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNIK1/1HwAFVQKH+f6iOwAAAABJRU5ErkJggg==',
  });
  const input = fixtureBotInput('그림 자료');
  input.package.images = [
    {
      id: 'portrait',
      title: '원래 그림',
      description: '원래 설명',
      blobHash: blob.hash,
      mime: blob.mime,
      allowedUse: 'profile',
    },
  ];
  const content = f.store.product.content(input);
  const task = runningTask(f);
  mutate(
    f,
    task,
    'image.update-metadata',
    {
      contentId: content.id,
      imageId: 'portrait',
      expectedRevision: content.revision,
      title: '새 그림',
      description: '새 설명',
    },
    'image'
  );
  finish(f, task);
  const edit = lastEdit(f)!;
  expect(edit).toMatchObject({ id: content.id, canUndo: true });
  undoHelperResourceEdit(f.store, f.workspace, f.conversation.id, edit.editSeq);
  expect(readResource(f.store, 'content', content.id)).toMatchObject({
    package: {
      images: [
        { id: 'portrait', title: '원래 그림', description: '원래 설명', blobHash: blob.hash },
      ],
    },
  });
});

test('edit and undo writes roll back with their durable provenance receipt', () => {
  const f = fixture();
  const task = runningTask(f);
  const content = f.store.product.content(fixtureBotInput('원래 제목'));
  f.store.db.exec(`CREATE TRIGGER reject_operation BEFORE INSERT ON helper_operations
    BEGIN SELECT RAISE(ABORT, 'receipt failed'); END`);
  expect(() =>
    mutate(f, task, 'resource.patch', patchTitle(content.id, 1, '새 제목'), 'atomic-edit')
  ).toThrow('receipt failed');
  expect(readResource(f.store, 'content', content.id)).toMatchObject({
    title: '원래 제목',
    revision: 1,
  });
  expect(lastEdit(f)).toBeNull();
  f.store.db.exec('DROP TRIGGER reject_operation');
  mutate(f, task, 'resource.patch', patchTitle(content.id, 1, '새 제목'), 'atomic-edit');
  const count = f.workspace.events(f.conversation.id).length;
  mutate(f, task, 'resource.patch', patchTitle(content.id, 1, '새 제목'), 'atomic-edit');
  expect(f.workspace.events(f.conversation.id)).toHaveLength(count);
  finish(f, task);
  const edit = lastEdit(f)!;
  f.store.db.exec(`CREATE TRIGGER reject_undo BEFORE INSERT ON helper_events
    WHEN NEW.kind='resource.edit.undone' BEGIN SELECT RAISE(ABORT, 'undo receipt failed'); END`);
  expect(() =>
    undoHelperResourceEdit(f.store, f.workspace, f.conversation.id, edit.editSeq)
  ).toThrow('undo receipt failed');
  expect(readResource(f.store, 'content', content.id)).toMatchObject({
    title: '새 제목',
    revision: 2,
  });
  expect(lastEdit(f)).toMatchObject({ canUndo: true });
  f.store.db.exec('DROP TRIGGER reject_undo');
  undoHelperResourceEdit(f.store, f.workspace, f.conversation.id, edit.editSeq);
  expect(readResource(f.store, 'content', content.id)).toMatchObject({
    title: '원래 제목',
    revision: 3,
  });
});
