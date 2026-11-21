import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import type { HelperTask } from '../core/helper.js';
import type { PromptPreset } from '../core/product.js';
import { editableResource } from '../core/resource-editing.js';
import { emptyTheme } from '../core/themes.js';
import * as transport from '../core/transport.js';
import { HelperResourceBatchError, patchHelperResources } from '../server/helper-resource-batch.js';
import { helperResourceOperation } from '../server/helper-resource-tools.js';
import { applyHelperResourceMutation } from '../server/helper-resource-mutation.js';
import { helperRoutes } from '../server/helper-routes.js';
import { HelperRuntime } from '../server/helper-runtime.js';
import { putImageBlob } from '../server/package-images.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { readResource, saveResource } from '../server/resource-service.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativePrompt } from './fixtures/native-prompt.js';

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
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-helper-mutation-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(f.path, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-helper-mutation-'));
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
    limits: { totalCalls: 24, helperCalls: 12 },
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
    applyHelperResourceMutation(
      f.store,
      f.workspace,
      task,
      key,
      name,
      args,
      operation.targets ?? operation.target
    )
  );
}
function finish(f: Fixture, task: HelperTask) {
  expect(f.workspace.finish(task.id, 'test-owner', 1, 'completed', '완료했어요.', null)).toBe(true);
}
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

test('a repeated clone receipt creates one copy and the model undo restores only that copy', () => {
  const f = fixture();
  const source = f.store.product.promptPreset({
    title: 'Version 1',
    role: 'main',
    program: nativePrompt('Saved body', {
      name: 'Authored native name',
      promptTemplate: [
        { id: 'core', type: 'plain', role: 'system', text: 'Saved body' },
        { type: 'plain', role: 'user', text: 'Redundant seal', custom: { preserve: true } },
      ],
    }),
    values: {},
  }) as PromptPreset;
  const task = runningTask(f);
  const args = {
    kind: 'prompt-preset',
    sourceId: source.id,
    expectedSourceRevision: source.revision,
    title: 'Version 2',
  };
  const presetsBefore = (f.store.product.all('prompt-preset') as PromptPreset[]).map(
    (preset) => preset.id
  );
  const copy = mutate(f, task, 'resource.clone', args, 'copy') as {
    id: string;
    revision: number;
  };
  expect(copy).toMatchObject({
    created: true,
    revision: 1,
    source: { id: source.id, revision: source.revision },
  });
  expect(copy.id).not.toBe(source.id);
  expect(mutate(f, task, 'resource.clone', args, 'copy')).toEqual(copy);
  expect(
    (f.store.product.all('prompt-preset') as PromptPreset[]).map((preset) => preset.id).sort()
  ).toEqual([...presetsBefore, copy.id].sort());
  expect(
    f.workspace.events(f.conversation.id).filter((event) => event.kind === 'resource.updated')
  ).toHaveLength(1);
  const before = readResource(f.store, 'prompt-preset', copy.id);
  mutate(
    f,
    task,
    'resource.patch',
    {
      kind: 'prompt-preset',
      id: copy.id,
      expectedRevision: copy.revision,
      changes: [
        { op: 'set', path: '/title', value: 'Version 2 polished' },
        { op: 'remove', path: '/program/nativeRisuPreset/preset/promptTemplate/1' },
      ],
    },
    'patch-copy'
  );
  mutate(
    f,
    task,
    'resource.undo',
    { kind: 'prompt-preset', id: copy.id, expectedRevision: 2 },
    'undo-copy'
  );
  finish(f, task);
  const restored = readResource(f.store, 'prompt-preset', copy.id);
  expect(restored.revision).toBe(3);
  expect(editableResource('prompt-preset', restored)).toEqual(
    editableResource('prompt-preset', before)
  );
  expect(readResource(f.store, 'prompt-preset', source.id)).toEqual(source);
});

test('runtime cloning uses saved source while an unsaved editor remains analysis input', async () => {
  const f = fixture();
  const source = f.store.product.promptPreset({
    title: 'Stored preset',
    role: 'main',
    program: nativePrompt('Saved source body'),
    values: {},
  }) as PromptPreset;
  const draft = {
    ...editableResource('prompt-preset', source),
    program: nativePrompt('Unsaved draft body'),
  };
  const presetsBefore = (f.store.product.all('prompt-preset') as PromptPreset[]).map(
    (preset) => preset.id
  );
  providerMutation('resource.clone', {
    kind: 'prompt-preset',
    sourceId: source.id,
    expectedSourceRevision: source.revision,
    title: 'Stored copy',
  });
  const task = f.runtime.enqueue(
    f.conversation.id,
    'clone-saved',
    '저장된 프리셋의 사본을 만들어줘',
    {
      kind: 'prompt-preset',
      targetId: source.id,
      revision: source.revision,
      title: source.title,
      source: 'unsaved',
      model: draft,
    }
  );
  await Promise.all(f.work);
  expect(f.workspace.task(task.id).status).toBe('completed');
  const operations = f.store.db
    .prepare('SELECT id FROM helper_operations WHERE task_id=?')
    .all(task.id);
  expect(operations).toHaveLength(1);
  const copies = (f.store.product.all('prompt-preset') as PromptPreset[]).filter(
    (preset) => !presetsBefore.includes(preset.id)
  );
  expect(copies).toHaveLength(1);
  const copy = copies[0];
  expect(readResource(f.store, 'prompt-preset', copy.id)).toMatchObject({
    title: 'Stored copy',
    revision: 1,
    program: source.program,
  });
  expect(draft.program).toEqual(nativePrompt('Unsaved draft body'));
  expect(readResource(f.store, 'prompt-preset', source.id)).toEqual(source);
  expect(
    f.workspace.events(f.conversation.id).filter((event) => event.kind === 'resource.updated')
  ).toHaveLength(1);
});

test('failed explanation keeps the theme save and its refresh events', async () => {
  const kind = 'theme' as const;
  const f = fixture();
  const model = emptyTheme('원래 설정');
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
  expect(readResource(f.store, kind, saved.id)).toMatchObject({ title: '변경한 설정' });
  const kinds = f.workspace.events(f.conversation.id).map((event) => event.kind);
  expect(kinds.filter((value) => value === `${kind}.updated`)).toHaveLength(1);
  expect(kinds.filter((value) => value === 'resource.updated')).toHaveLength(1);
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
  mutate(
    f,
    task,
    'resource.undo',
    { kind: 'content', id: content.id, expectedRevision: 2 },
    'undo-image'
  );
  finish(f, task);
  expect(readResource(f.store, 'content', content.id)).toMatchObject({
    package: {
      images: [
        { id: 'portrait', title: '원래 그림', description: '원래 설명', blobHash: blob.hash },
      ],
    },
  });
});

test('an edit rolls back with its durable provenance receipt', () => {
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
  f.store.db.exec('DROP TRIGGER reject_operation');
  mutate(f, task, 'resource.patch', patchTitle(content.id, 1, '새 제목'), 'atomic-edit');
  const count = f.workspace.events(f.conversation.id).length;
  mutate(f, task, 'resource.patch', patchTitle(content.id, 1, '새 제목'), 'atomic-edit');
  expect(f.workspace.events(f.conversation.id)).toHaveLength(count);
});

test.each(['stale', 'duplicate'] as const)(
  'multi-resource patch rejects %s second item without changing saved resources or undo',
  (failure) => {
    const f = fixture();
    const contents = ['첫 자료', '둘째 자료'].map((title) =>
      f.store.product.content(fixtureBotInput(title))
    );
    const first = saveResource(f.store, {
      kind: 'content',
      id: contents[0].id,
      expectedRevision: 1,
      model: fixtureBotInput('첫 자료 이전 수정'),
    }).saved;
    const previousUndo = f.store.db.prepare('SELECT * FROM resource_undo ORDER BY kind,id').all();
    const task = runningTask(f);
    const second = patchTitle(contents[1].id, failure === 'stale' ? 9 : 1, '둘째 변경');
    const items = [
      patchTitle(contents[0].id, first.revision, '첫 변경'),
      failure === 'duplicate' ? patchTitle(contents[0].id, first.revision, '다시 변경') : second,
    ];
    let failureResult: unknown;
    try {
      mutate(f, task, 'resource.patchMany', { items }, 'failed-batch');
    } catch (error) {
      failureResult = error;
    }
    expect(failureResult).toBeInstanceOf(HelperResourceBatchError);
    expect(failureResult).toMatchObject({
      itemIndex: 1,
      kind: 'content',
      id: items[1].id,
      statusCode: failure === 'stale' ? 409 : 400,
      cause: { statusCode: failure === 'stale' ? 409 : 400 },
    });
    expect(readResource(f.store, 'content', contents[0].id)).toEqual(first);
    expect(readResource(f.store, 'content', contents[1].id)).toEqual(contents[1]);
    expect(f.store.db.prepare('SELECT * FROM resource_undo ORDER BY kind,id').all()).toEqual(
      previousUndo
    );
    expect(f.store.db.prepare('SELECT * FROM helper_operations').all()).toHaveLength(0);
    expect(
      f.workspace.events(f.conversation.id).filter((event) => event.kind.startsWith('resource.'))
    ).toHaveLength(0);
  }
);

test('batch boundaries reject invalid count and targets before storing any resource', () => {
  const f = fixture();
  const content = f.store.product.content(fixtureBotInput('원래 제목'));
  const item = patchTitle(content.id, content.revision, '변경 제목');
  for (const items of [[], Array.from({ length: 17 }, () => item), null])
    expect(() => patchHelperResources(f.store, items)).toThrow('1개부터 16개');
  for (const invalid of [
    { ...item, kind: 'theme' },
    { ...item, id: '' },
    { ...item, expectedRevision: 0 },
    { ...item, changes: [] },
  ])
    expect(() => patchHelperResources(f.store, [item, invalid])).toThrow(HelperResourceBatchError);
  const task = runningTask(f);
  expect(() =>
    mutate(
      f,
      task,
      'resource.patchMany',
      {
        items: [item, { ...item, kind: 'invalid' }, { ...item, id: 'missing-resource' }],
      },
      'invalid-item'
    )
  ).toThrow(expect.objectContaining({ itemIndex: 1, statusCode: 400 }));
  expect(readResource(f.store, 'content', content.id)).toEqual(content);
  expect(f.store.db.prepare('SELECT * FROM resource_undo').all()).toHaveLength(0);
});

test('mixed batch reports every member and keeps bodies out of its result', () => {
  const f = fixture();
  const content = f.store.product.content(
    fixtureBotInput('자료 원본', '본문은 기록에 남기지 않음')
  );
  const preset = f.store.product.promptPreset({
    title: '프리셋 원본',
    role: 'main',
    program: nativePrompt('프리셋 본문은 기록에 남기지 않음'),
    values: {},
  }) as PromptPreset;
  const unchanged = f.store.product.content(fixtureBotInput('변경 없는 자료'));
  const task = runningTask(f);
  const args = {
    items: [
      patchTitle(content.id, 1, '자료 변경'),
      {
        kind: 'prompt-preset',
        id: preset.id,
        expectedRevision: 1,
        changes: [{ op: 'set', path: '/title', value: '프리셋 변경' }],
      },
      patchTitle(unchanged.id, 1, unchanged.title),
    ],
  };
  const result = mutate(f, task, 'resource.patchMany', args, 'batch') as { items: unknown[] };
  expect(result.items).toEqual([
    {
      kind: 'content',
      id: content.id,
      revision: 2,
      changedPaths: ['/package/nativeRisu/card/name'],
    },
    { kind: 'prompt-preset', id: preset.id, revision: 2, changedPaths: ['/title'] },
    { kind: 'content', id: unchanged.id, revision: 1, changedPaths: [] },
  ]);
  expect(mutate(f, task, 'resource.patchMany', args, 'batch')).toEqual(result);
  expect(JSON.stringify(result)).not.toContain('본문은 기록에 남기지 않음');
});

test('an unchanged batch records no resource event', () => {
  const f = fixture();
  const contents = ['첫 자료', '둘째 자료'].map((title) =>
    f.store.product.content(fixtureBotInput(title))
  );
  const task = runningTask(f);
  const items = contents.map((content) => patchTitle(content.id, 1, content.title));
  mutate(f, task, 'resource.patchMany', { items }, 'no-changes');
  expect(
    f.workspace.events(f.conversation.id).filter((event) => event.kind.startsWith('resource.'))
  ).toHaveLength(0);
});

test('batch save rolls back every member if its durable receipt fails', () => {
  const f = fixture();
  const contents = ['첫 자료', '둘째 자료'].map((title) =>
    f.store.product.content(fixtureBotInput(title))
  );
  const task = runningTask(f);
  const args = {
    items: contents.map((content) => patchTitle(content.id, 1, `${content.title} 변경`)),
  };
  f.store.db.exec(`CREATE TRIGGER reject_batch_operation BEFORE INSERT ON helper_operations
    BEGIN SELECT RAISE(ABORT, 'batch receipt failed'); END`);
  expect(() => mutate(f, task, 'resource.patchMany', args, 'batch')).toThrow(
    'batch receipt failed'
  );
  for (const content of contents)
    expect(readResource(f.store, 'content', content.id)).toEqual(content);
  f.store.db.exec('DROP TRIGGER reject_batch_operation');
  mutate(f, task, 'resource.patchMany', args, 'batch');
  for (const content of contents)
    expect(readResource(f.store, 'content', content.id)).toMatchObject({
      title: `${content.title} 변경`,
      revision: 2,
    });
});

test('runtime blocks the whole batch when its second target has an unsaved editor', async () => {
  const f = fixture();
  const contents = ['첫 자료', '둘째 자료'].map((title) =>
    f.store.product.content(fixtureBotInput(title))
  );
  providerMutation('resource.patchMany', {
    items: contents.map((content) =>
      patchTitle(content.id, content.revision, `${content.title} 변경`)
    ),
  });
  const second = contents[1];
  const task = f.runtime.enqueue(f.conversation.id, 'dirty-batch', '두 자료를 함께 고쳐줘', {
    kind: 'content',
    targetId: second.id,
    revision: second.revision,
    title: second.title,
    source: 'unsaved',
    model: fixtureBotInput('보존할 미저장 내용'),
  });
  await Promise.all(f.work);
  expect(f.workspace.task(task.id).status).toBe('completed');
  const events = f.workspace.events(f.conversation.id);
  expect(events.find((event) => event.kind === 'tool.finished')?.data).toMatchObject({
    name: 'resource.patchMany',
    denied: true,
  });
  expect(vi.mocked(transport.executeProvider).mock.calls[1][1].input.results).toMatchObject([
    { denied: true, result: { code: 'EDITOR_SAVE_REQUIRED' } },
  ]);
  for (const content of contents)
    expect(readResource(f.store, 'content', content.id)).toEqual(content);
  expect(f.store.db.prepare('SELECT * FROM helper_operations').all()).toHaveLength(0);
});
