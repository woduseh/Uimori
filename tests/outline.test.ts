import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createFixtureChat } from './fixtures/chat.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { Store, type HttpError } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import { directHelperGrants } from '../server/helper-workspace.js';
import { buildMainProviderRequest } from '../server/main-request.js';
import { OUTLINE_LEVEL_LABELS } from '../core/outline.js';
import type { RunSnapshot } from '../core/types.js';
import type { Connection, ModelPreset } from '../core/product.js';

const owned: { directory: string; store: Store }[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('External calls forbidden in outline tests')
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    item.store.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('Uimori outline tests ')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori outline tests '));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
}
/** A chat whose main route resolves, so a real generation request can be built without any call. */
function chatWithMainModel(store: Store, title: string) {
  const chat = createFixtureChat(store, title);
  const connection = store.product.connection({
    title: 'Synthetic outline connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:1/sse',
    credentialEnv: 'UIMORI_OUTLINE_TEST_KEY',
    enabled: true,
  }) as Connection;
  const model = store.product.model({
    title: 'Synthetic outline model',
    connectionId: connection.id,
    modelId: 'synthetic-outline-model',
    inputTokenLimit: 8192,
    maxOutputTokens: 4096,
    temperature: null,
  }) as ModelPreset;
  const profile = store.product.profile(chat.id);
  updateTestProfile(store.product, chat.id, {
    expectedRevision: profile.revision,
    attachments: [],
    routes: { main: { id: model.id }, translation: null, status: null, image: null },
    image: profile.image,
  });
  return chat;
}
const failure = (act: () => unknown) => {
  try {
    act();
  } catch (error) {
    return error as HttpError;
  }
  throw new Error('Expected the write to be refused');
};

/** Three episodes composed from theme down to beats, with no prose written. */
function compose(store: Store, chatId: string, key = randomUUID()) {
  return store.outline.apply(
    chatId,
    {
      idempotencyKey: key,
      operations: [
        {
          op: 'create',
          ref: 'theme',
          level: 'theme',
          title: '잊힌 이름을 되찾는 이야기',
          intent: '기억을 빼앗긴 인물이 자기 이름을 되찾는 과정을 다뤄요.',
        },
        {
          op: 'create',
          ref: 'main',
          parentRef: 'theme',
          level: 'mainStory',
          title: '이름 없는 사서',
          intent: '사서가 도서관 지하에서 자기 이름이 적힌 장부를 찾아요.',
        },
        {
          op: 'create',
          ref: 'arc',
          parentRef: 'main',
          level: 'arc',
          title: '지하 서고의 발견',
          intent: '결말에서 관장이 배신자로 드러나요. 이 사건에서는 아직 감추어요.',
        },
        {
          op: 'create',
          ref: 'ep1',
          parentRef: 'arc',
          level: 'episode',
          title: '1화 잠긴 문',
          intent: '사서가 지하 서고의 잠긴 문을 발견해요.',
        },
        {
          op: 'create',
          ref: 'ep1-b1',
          parentRef: 'ep1',
          level: 'beat',
          title: '열쇠 없는 자물쇠',
          intent: '자물쇠에 열쇠 구멍이 없다는 것을 알아채요.',
        },
        {
          op: 'create',
          ref: 'ep2',
          parentRef: 'arc',
          level: 'episode',
          title: '2화 장부의 첫 장',
          intent: '문을 열고 장부의 첫 장을 읽어요.',
        },
        {
          op: 'create',
          ref: 'ep3',
          parentRef: 'arc',
          level: 'episode',
          title: '3화 관장의 방문',
          intent: '관장이 서고를 찾아와요.',
        },
      ],
    },
    'user'
  );
}
const find = (store: Store, chatId: string, title: string) => {
  const node = store.outline.detail(chatId).nodes.find((item) => item.title === title);
  if (!node) throw new Error(`Missing composition node ${title}`);
  return node;
};

/** Reserve and complete one run through the existing main writing path. */
function write(store: Store, chatId: string, commandId: string, text: string) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const branch = store.product.branch(chatId);
  const command = store.story.command(commandId);
  const run = store.createRun(
    chatId,
    {
      request: command.request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: store.product.profile(chatId).revision,
      idempotencyKey: randomUUID(),
      branchId: command.branchId,
      sceneCommandId: command.id,
    },
    (current) =>
      ({
        chatId,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request: command.request,
        history: store.history(current.headRevision),
        resources: store.product.resources(chatId, profile),
        ...(profile ? { profile } : {}),
      }) satisfies RunSnapshot
  ).run;
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    text,
    { modelCalls: 1, inputTokens: 10, outputTokens: 20, costUsd: null },
    run.snapshot.settings
  );
  return { run: store.run(run.id), source };
}

describe('hierarchical composition', () => {
  test('a scene requested the existing way still writes with no composition attached', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '즉흥 집필 검사');
    const request = '미라가 지도를 살펴보는 장면을 써 주세요.';
    const branch = store.product.branch(chat.id);
    const profile = store.product.snapshot(chat.id);
    const run = store.createRun(
      chat.id,
      {
        request,
        expectedRevision: branch.headRevision,
        expectedSettingsRevision: store.chat(chat.id).settingsRevision,
        expectedProfileRevision: store.product.profile(chat.id).revision,
        idempotencyKey: randomUUID(),
      },
      (current) =>
        ({
          chatId: chat.id,
          parentRevision: current.headRevision,
          settingsRevision: current.settingsRevision,
          settings: current.settings,
          request,
          history: store.history(current.headRevision),
          resources: store.product.resources(chat.id, profile),
          ...(profile ? { profile } : {}),
        }) satisfies RunSnapshot
    ).run;
    store.startRun(run.id);
    const source = store.completeRun(
      run.id,
      '미라는 지도를 펼쳤다.',
      { modelCalls: 1, inputTokens: 5, outputTokens: 9, costUsd: null },
      run.snapshot.settings
    );
    // No composition exists, so nothing is frozen and no composition input is required.
    expect(store.run(run.id).snapshot.outline).toBeUndefined();
    expect(store.product.branch(chat.id).headRevision).toBe(source.id);
    expect(store.outline.detail(chat.id).nodes).toEqual([]);
  });

  test('composes five levels without writing any prose', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '구성 검사');
    const before = store.product.branch(chat.id).headRevision;
    const { detail, created } = compose(store, chat.id);
    expect(created).toHaveLength(7);
    expect(detail.nodes.map((node) => node.level)).toEqual([
      'theme',
      'mainStory',
      'arc',
      'episode',
      'beat',
      'episode',
      'episode',
    ]);
    const arc = find(store, chat.id, '지하 서고의 발견');
    expect(detail.nodes.filter((node) => node.parentId === arc.id)).toHaveLength(3);
    // Composition alone never counts as written and never commits story text.
    expect(detail.nodes.every((node) => node.progress.state === 'planned')).toBe(true);
    expect(store.product.branch(chat.id).headRevision).toBe(before);
    expect(store.chat(chat.id).headRevision).toBe(before);
  });

  test('rejects a level placed under the wrong parent', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '수준 검사');
    compose(store, chat.id);
    const theme = find(store, chat.id, '잊힌 이름을 되찾는 이야기');
    const error = failure(() =>
      store.outline.apply(
        chat.id,
        {
          idempotencyKey: randomUUID(),
          operations: [
            {
              op: 'create',
              parentId: theme.id,
              level: 'episode',
              title: '잘못된 회차',
              intent: '',
            },
          ],
        },
        'user'
      )
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain(OUTLINE_LEVEL_LABELS.arc);
  });

  test('a replayed batch reuses the created nodes instead of duplicating them', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '중복 검사');
    const key = randomUUID();
    const first = compose(store, chat.id, key);
    const second = compose(store, chat.id, key);
    expect(second.created).toEqual(first.created);
    expect(second.detail.nodes).toHaveLength(first.detail.nodes.length);
  });

  test('writing one episode carries the upper intent into the real generation input', async () => {
    const store = await database();
    const chat = chatWithMainModel(store, '집필 연결 검사');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문');
    const command = store.outline.sceneCommand(episode.id, { idempotencyKey: randomUUID() });
    expect(command.request).toContain('1화 잠긴 문');
    expect(store.outline.node(episode.id).progress.state).toBe('scheduled');

    const { run, source } = write(store, chat.id, command.id, '문은 잠겨 있었다.');
    const outline = run.snapshot.outline;
    if (!outline) throw new Error('Expected frozen composition');
    expect(outline.path.map((item) => item.level)).toEqual([
      'theme',
      'mainStory',
      'arc',
      'episode',
    ]);
    expect(outline.path.at(-1)?.id).toBe(episode.id);
    expect(outline.children.map((item) => item.title)).toEqual(['열쇠 없는 자물쇠']);
    // Only this unit is named; sibling episodes stay out of the frozen composition.
    expect(JSON.stringify(outline)).not.toContain('2화 장부의 첫 장');

    const { request } = buildMainProviderRequest(run.snapshot);
    const sent = JSON.stringify(request);
    expect(sent).toContain('사서가 도서관 지하에서 자기 이름이 적힌 장부를 찾아요.');
    expect(sent).toContain('열쇠 없는 자물쇠');
    expect(request.stable.contract).toContain('planning, not story that already happened');

    // One request writes exactly one source, and only its own unit becomes written.
    expect(store.product.branch(chat.id).headRevision).toBe(source.id);
    const nodes = store.outline.detail(chat.id).nodes;
    expect(nodes.find((node) => node.id === episode.id)?.progress).toMatchObject({
      state: 'written',
      sourceRevision: source.id,
    });
    expect(
      nodes.filter((node) => node.id !== episode.id).every((n) => n.progress.state === 'planned')
    ).toBe(true);
  });

  test('a later unit is never reported as written or leaked as past fact', async () => {
    const store = await database();
    const chat = chatWithMainModel(store, '미래 분리 검사');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문');
    const command = store.outline.sceneCommand(episode.id, { idempotencyKey: randomUUID() });
    const { run } = write(store, chat.id, command.id, '문은 잠겨 있었다.');
    expect(run.snapshot.outline?.written).toEqual([]);
    // The arc names the ending; it arrives as author intent under the disclosure contract only.
    const { input } = buildMainProviderRequest(run.snapshot);
    expect(input.contract).toContain('stay unrevealed until their own unit is written');
    expect(store.story.detail(chat.id).notes).toEqual([]);
    expect(store.context.detail(chat.id).checkpoint).toBeNull();
  });

  test('an earlier written sibling enters the next unit as real, in-ancestry history', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '선행 회차 검사');
    compose(store, chat.id);
    const first = find(store, chat.id, '1화 잠긴 문');
    const firstCommand = store.outline.sceneCommand(first.id, { idempotencyKey: randomUUID() });
    const written = write(store, chat.id, firstCommand.id, '문은 잠겨 있었다.');
    const second = find(store, chat.id, '2화 장부의 첫 장');
    const secondCommand = store.outline.sceneCommand(second.id, { idempotencyKey: randomUUID() });
    const next = write(store, chat.id, secondCommand.id, '장부의 첫 장을 펼쳤다.');
    expect(next.run.snapshot.outline?.written).toEqual([
      {
        id: first.id,
        level: 'episode',
        title: '1화 잠긴 문',
        sourceRevision: written.source.id,
      },
    ]);
  });

  test('only episode and beat levels can be written by one request', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '집필 단위 검사');
    compose(store, chat.id);
    const arc = find(store, chat.id, '지하 서고의 발견');
    const error = failure(() =>
      store.outline.sceneCommand(arc.id, { idempotencyKey: randomUUID() })
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain(OUTLINE_LEVEL_LABELS.episode);
  });

  test('a user edit applies to the named target under revision control', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '구성 수정 검사');
    compose(store, chat.id);
    const first = find(store, chat.id, '1화 잠긴 문');
    const command = store.outline.sceneCommand(first.id, { idempotencyKey: randomUUID() });
    const { source } = write(store, chat.id, command.id, '문은 잠겨 있었다.');
    const third = find(store, chat.id, '3화 관장의 방문');
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'update',
            id: third.id,
            expectedRevision: third.revision,
            intent: '관장 대신 조수가 찾아와요.',
          },
        ],
      },
      'user'
    );
    expect(find(store, chat.id, '3화 관장의 방문').intent).toBe('관장 대신 조수가 찾아와요.');
    // Changing remaining composition never touches prose that is already written.
    expect(store.source(source.id).text).toBe('문은 잠겨 있었다.');
    expect(store.source(source.id).hash).toBe(source.hash);
    expect(find(store, chat.id, '1화 잠긴 문').intent).toBe(
      '사서가 지하 서고의 잠긴 문을 발견해요.'
    );

    const stale = failure(() =>
      store.outline.apply(
        chat.id,
        {
          idempotencyKey: randomUUID(),
          operations: [
            { op: 'update', id: third.id, expectedRevision: third.revision, intent: '되돌리기' },
          ],
        },
        'user'
      )
    );
    expect(stale.statusCode).toBe(409);
  });

  test('a model write surfaces a pinned condition as a conflict', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '고정 충돌 검사');
    compose(store, chat.id);
    const third = find(store, chat.id, '3화 관장의 방문');
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [{ op: 'update', id: third.id, expectedRevision: third.revision, fixed: true }],
      },
      'user'
    );
    const pinned = find(store, chat.id, '3화 관장의 방문');
    const change = {
      idempotencyKey: randomUUID(),
      operations: [
        { op: 'update', id: pinned.id, expectedRevision: pinned.revision, intent: '조수가 와요.' },
      ],
    };
    const conflict = failure(() => store.outline.apply(chat.id, change, 'model'));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.message).toContain('3화 관장의 방문');
    expect(find(store, chat.id, '3화 관장의 방문').intent).toBe('관장이 서고를 찾아와요.');
    // A user's own instruction may still change what the user pinned.
    store.outline.apply(chat.id, change, 'user');
    expect(find(store, chat.id, '3화 관장의 방문').intent).toBe('조수가 와요.');
  });

  test('a model cannot rewrite or remove an already written unit, and pins stay user-owned', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '과거 보호 검사');
    compose(store, chat.id);
    const first = find(store, chat.id, '1화 잠긴 문');
    const command = store.outline.sceneCommand(first.id, { idempotencyKey: randomUUID() });
    write(store, chat.id, command.id, '문은 잠겨 있었다.');
    const written = find(store, chat.id, '1화 잠긴 문');
    const rewrite = failure(() =>
      store.outline.apply(
        chat.id,
        {
          idempotencyKey: randomUUID(),
          operations: [
            { op: 'update', id: written.id, expectedRevision: written.revision, intent: '다르게' },
          ],
        },
        'model'
      )
    );
    expect(rewrite.statusCode).toBe(409);
    expect(rewrite.message).toContain('남은 구성만');
    for (const authority of ['model', 'user'] as const) {
      const removal = failure(() =>
        store.outline.apply(
          chat.id,
          {
            idempotencyKey: randomUUID(),
            operations: [{ op: 'remove', id: written.id, expectedRevision: written.revision }],
          },
          authority
        )
      );
      expect(removal.statusCode).toBe(409);
      expect(removal.message).toContain('집필한 구성은 삭제하지 않아요');
    }
    const pin = failure(() =>
      store.outline.apply(
        chat.id,
        {
          idempotencyKey: randomUUID(),
          operations: [
            { op: 'update', id: written.id, expectedRevision: written.revision, fixed: true },
          ],
        },
        'model'
      )
    );
    expect(pin.statusCode).toBe(403);
  });

  test('removing an unwritten branch of composition takes its reserved scene command with it', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '구성 삭제 검사');
    compose(store, chat.id);
    const third = find(store, chat.id, '3화 관장의 방문');
    const command = store.outline.sceneCommand(third.id, { idempotencyKey: randomUUID() });
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          { op: 'remove', id: third.id, expectedRevision: store.outline.node(third.id).revision },
        ],
      },
      'user'
    );
    expect(store.outline.detail(chat.id).nodes.some((node) => node.id === third.id)).toBe(false);
    // The reserved command was never run, so nothing about it is history worth keeping.
    expect(failure(() => store.story.command(command.id)).statusCode).toBe(404);
    expect(store.story.detail(chat.id).commands).toEqual([]);
  });

  test('a fork keeps composition but never inherits another line’s completed units', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '포크 검사');
    compose(store, chat.id);
    const first = find(store, chat.id, '1화 잠긴 문');
    const firstCommand = store.outline.sceneCommand(first.id, { idempotencyKey: randomUUID() });
    const opening = write(store, chat.id, firstCommand.id, '문은 잠겨 있었다.');
    const second = find(store, chat.id, '2화 장부의 첫 장');
    const secondCommand = store.outline.sceneCommand(second.id, { idempotencyKey: randomUUID() });
    write(store, chat.id, secondCommand.id, '장부의 첫 장을 펼쳤다.');

    const forked = forkChat(store, chat.id, {
      fromRevision: opening.source.id,
      idempotencyKey: randomUUID(),
    });
    const nodes = store.outline.detail(forked.id).nodes;
    expect(nodes.map((node) => node.title)).toEqual(
      store.outline.detail(chat.id).nodes.map((node) => node.title)
    );
    expect(nodes.every((node) => node.branchId === `main:${forked.id}`)).toBe(true);
    const forkedFirst = nodes.find((node) => node.title === '1화 잠긴 문');
    const forkedSecond = nodes.find((node) => node.title === '2화 장부의 첫 장');
    expect(forkedFirst?.progress.state).toBe('written');
    // The second episode was written after the fork point on the original line only.
    expect(forkedSecond?.progress.state).toBe('planned');
    expect(forkedSecond?.progress.sourceRevision).toBeNull();
  });

  test('a pin protects its own wording, not the planning beneath it', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '고정 범위 검사');
    compose(store, chat.id);
    const arc = find(store, chat.id, '지하 서고의 발견');
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [{ op: 'update', id: arc.id, expectedRevision: arc.revision, fixed: true }],
      },
      'user'
    );
    const pinned = find(store, chat.id, '지하 서고의 발견');
    // Planning a further episode under a pinned arc does not change the pinned condition.
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'create',
            parentId: pinned.id,
            level: 'episode',
            title: '4화 빈 서가',
            intent: '서가 하나가 비어 있어요.',
          },
        ],
      },
      'model'
    );
    expect(find(store, chat.id, '4화 빈 서가').parentId).toBe(pinned.id);
    const conflict = failure(() =>
      store.outline.apply(
        chat.id,
        {
          idempotencyKey: randomUUID(),
          operations: [
            { op: 'update', id: pinned.id, expectedRevision: pinned.revision, intent: '다르게' },
          ],
        },
        'model'
      )
    );
    expect(conflict.statusCode).toBe(409);
  });

  test('a fork copies only the composition of the branch it forked from', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '분기 귀속 검사');
    compose(store, chat.id);
    const first = find(store, chat.id, '1화 잠긴 문');
    const command = store.outline.sceneCommand(first.id, { idempotencyKey: randomUUID() });
    const opening = write(store, chat.id, command.id, '문은 잠겨 있었다.');
    const other = store.product.createBranch(chat.id, {
      title: '다른 갈래',
      fromRevision: opening.source.id,
    });
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'create',
            level: 'theme',
            title: '다른 갈래 주제',
            intent: '이 갈래만의 주제예요.',
          },
        ],
        branchId: other.id,
      },
      'user'
    );
    expect(store.outline.detail(chat.id, other.id).nodes.map((node) => node.title)).toEqual([
      '다른 갈래 주제',
    ]);

    const forked = forkChat(store, chat.id, {
      fromRevision: opening.source.id,
      idempotencyKey: randomUUID(),
    });
    const titles = store.outline.detail(forked.id).nodes.map((node) => node.title);
    expect(titles).toContain('1화 잠긴 문');
    expect(titles).not.toContain('다른 갈래 주제');
  });

  test('composition survives the archive export and restore path', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '보관 검사');
    compose(store, chat.id);
    const archive = store.product.export();
    expect(archive.tables.outline_nodes).toHaveLength(7);
    const restored = await database();
    restored.product.import(archive);
    expect(restored.outline.detail(chat.id).nodes.map((node) => node.title)).toEqual(
      store.outline.detail(chat.id).nodes.map((node) => node.title)
    );
  });

  test('a clear composition instruction grants the outline write, quoted text does not', () => {
    const scope = { kind: 'chat', chatId: 'chat-1', branchId: 'main:chat-1' } as const;
    const granted = directHelperGrants(
      'request-1',
      scope,
      '3화 분량을 주제부터 작은 사건까지 구성해 줘'
    );
    expect(granted[0]?.actions).toContain('outline.write');
    expect(granted[0]?.provenance).toBe('direct-user-request');
    expect(
      directHelperGrants('request-2', scope, '이 문장 "구성을 바꿔 줘" 는 인물의 대사예요.')
    ).toEqual([]);
    expect(directHelperGrants('request-3', scope, '남은 구성이 어떻게 되어 있어?')).toEqual([]);
  });
});
