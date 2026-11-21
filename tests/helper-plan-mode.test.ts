import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { HelperTask } from '../core/helper.js';
import * as transport from '../core/transport.js';
import { createApp, type App } from '../server/app.js';
import { HELPER_APP_TOOLS, helperToolTraits } from '../server/helper-app-tools.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import {
  helperDone,
  runScriptedChatHelper,
  selectFixtureModels,
} from './fixtures/scripted-helper.js';

const owned: { close: () => unknown; directory: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { close, directory } of owned.splice(0)) {
    await close();
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-plan-mode-'))
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

function storeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-plan-mode-'));
  const store = new Store(join(directory, 'plan.sqlite'));
  owned.push({ close: () => store.close(), directory });
  const model = selectFixtureModels(store);
  const chat = createFixtureChat(store, '계획 채팅');
  completedSource(store, chat.id, '첫 장면이에요.\n');
  return { store, chat, model };
}

test('plan mode refuses every operation that writes and runs the reads', async () => {
  const { store, chat } = storeFixture();
  const toolCalls = HELPER_APP_TOOLS.map((tool) => ({
    id: tool.name,
    name: 'app.call',
    arguments: { name: tool.name, arguments: {} },
  }));
  const run = await runScriptedChatHelper(
    store,
    chat.id,
    [{ ...structuredClone(helperDone), status: 'tool_calls', toolCalls }],
    {},
    { mode: 'plan' }
  );
  const refused = HELPER_APP_TOOLS.filter(
    (tool) => run.finished(tool.name)?.errorCode === 'PLAN_MODE_READ_ONLY'
  ).map((tool) => tool.name);
  expect(refused).toEqual(
    HELPER_APP_TOOLS.filter((tool) => !helperToolTraits(tool.name).readOnly).map(
      (tool) => tool.name
    )
  );
  expect(refused).toEqual(
    expect.arrayContaining(['resource.delete', 'scene.patch', 'scene.request'])
  );
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(run.task.id)
  ).toEqual({ n: 0 });
  expect(run.task.mode).toBe('plan');
  expect(run.requests[0]!.stable.contract).toContain('This request is in plan mode');
  expect(run.runtime.workspace.taskSummary(run.task.id).mode).toBe('plan');
});

test('the receipt writer refuses a plan task, so a save path outside the tool gate cannot commit', () => {
  const { store, chat, model } = storeFixture();
  const workspace = new HelperWorkspace(store);
  const conversation = workspace.open({ kind: 'chat', chatId: chat.id });
  const task = workspace.enqueue(conversation.id, randomUUID(), 'Plan', {
    mode: 'plan',
    scope: conversation.scope,
    model: store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    limits: { helperCalls: 1, totalCalls: 1 },
  });
  workspace.start(task.id, 'plan-fixture');
  const apply = vi.fn(() => ({ saved: true }));
  expect(() => workspace.operation(task.id, `${task.id}:shell`, { name: 'apply' }, apply)).toThrow(
    'PLAN_MODE_READ_ONLY'
  );
  expect(apply).not.toHaveBeenCalled();
  expect(workspace.task(task.id).mode).toBe('plan');
});

test('an operation joins the read classification only by updating this reviewed list', () => {
  expect(
    HELPER_APP_TOOLS.filter((tool) => helperToolTraits(tool.name).readOnly)
      .map((tool) => tool.name)
      .sort()
  ).toEqual([
    'artifact.read',
    'chat.list',
    'chat.preview',
    'chat.read',
    'chat.variables.read',
    'context.read',
    'data.read',
    'data.search',
    'db.query',
    'editor.read',
    'font.list',
    'illustration-preset.guide',
    'illustration-preset.list',
    'illustration.continuity.read',
    'illustration.cut.read',
    'illustration.cuts.list',
    'illustration.image.list',
    'illustration.image.read',
    'illustration.profiles.read',
    'illustration.scene.read',
    'image.list',
    'image.read',
    'knowledge.read',
    'knowledge.search',
    'model.list',
    'model.parameters.read',
    'model.pricing.read',
    'options.read',
    'outline.read',
    'palette.list',
    'preset.validate',
    'resource.read',
    'resource.readMany',
    'scene.lore',
    'scene.read',
    'scene.search',
    'scene.versions',
    'settings.read',
    'skills.list',
    'skills.load',
    'story.read',
    'story.search',
    'task.inspect',
    'task.list',
    'theme.guide',
    'theme.list',
    'usage.read',
    'vertex.location.read',
  ]);
  for (const name of ['chat.lore', 'library.organize']) {
    expect(helperToolTraits(name, { action: 'read' }).readOnly).toBe(true);
    expect(helperToolTraits(name, { action: 'move' }).readOnly).toBe(false);
  }
});

test('a request carries its mode to the task list and cannot change it under the same key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-plan-mode-'));
  const app: App = await createApp({
    dbPath: join(directory, 'plan.sqlite'),
    buildId: 'helper-plan-mode',
    testMode: true,
  });
  owned.push({ close: () => app.close(), directory });
  selectFixtureModels(app.store);
  vi.spyOn(transport, 'executeProvider').mockImplementation(async (_target, _request, options) => {
    options.beforeTurn?.();
    return structuredClone(helperDone);
  });
  const chat = createFixtureChat(app.store, '계획 채팅');
  const conversation = (
    await app.inject({
      method: 'POST',
      url: '/api/helper/conversations',
      payload: { scope: { kind: 'chat', chatId: chat.id } },
    })
  ).json<{ id: string }>();
  const send = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/helper/conversations/${conversation.id}/messages`,
      payload,
    });
  expect((await send({ requestKey: 'bad', text: '계획', mode: 'draft' })).statusCode).toBe(400);
  const planned = await send({ requestKey: 'plan', text: '계획만 세워 줘', mode: 'plan' });
  expect(planned.json<HelperTask>().mode).toBe('plan');
  expect((await send({ requestKey: 'plan', text: '계획만 세워 줘' })).statusCode).toBe(409);
  const applied = await send({ requestKey: 'apply', text: '바로 고쳐 줘' });
  expect(applied.json<HelperTask>().mode).toBe('apply');
  await vi.waitFor(async () =>
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/helper/conversations/${conversation.id}/tasks`,
        })
      )
        .json<HelperTask[]>()
        .map((task) => [task.mode, task.status])
    ).toEqual([
      ['apply', 'completed'],
      ['plan', 'completed'],
    ])
  );
});
