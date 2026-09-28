import { observeExecutions, observedExecution } from './fixtures/execution-observer.js';
import { prepareNativeRisuReadOnly } from '../server/risu-native-readonly.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createFixtureChat } from './fixtures/chat.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { Store, type HttpError } from '../server/store.js';

import { buildMainProviderRequest } from '../server/main-request.js';
import { OUTLINE_CONTRACT, OUTLINE_LEVEL_LABELS } from '../core/outline.js';
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
  observeExecutions(store);
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
    credentialRef: 'UIMORI_OUTLINE_TEST_KEY',
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
    routes: { main: { id: model.id }, translation: null, status: null },
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

/** Reserve through the same Store boundary used by the scene-command run route. */
function reserve(store: Store, chatId: string, commandId: string, key = randomUUID()) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const branch = store.product.branch(chatId);
  const command = store.story.command(commandId);
  return store.createRun(
    chatId,
    {
      request: command.request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: store.product.profile(chatId).revision,
      idempotencyKey: key,
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
}

/** Reserve and complete one run through the existing main writing path. */
function write(store: Store, chatId: string, commandId: string, text: string) {
  const run = reserve(store, chatId, commandId);
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    text,
    { modelCalls: 1, inputTokens: 10, outputTokens: 20, costUsd: null },
    run.snapshot.settings
  );
  return { run: observedExecution(store, run.id), source };
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
    expect(observedExecution(store, run.id).snapshot.outline).toBeUndefined();
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

  test('allows skipped levels and standalone units but rejects inversions and cross-chat parents', async () => {
    const store = await database(),
      chat = createFixtureChat(store, '유연한 구성');
    compose(store, chat.id);
    const theme = find(store, chat.id, '잊힌 이름을 되찾는 이야기');
    const created = store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          { op: 'create', level: 'episode', parentId: theme.id, title: '건너뛴 회차', intent: '' },
          { op: 'create', level: 'beat', title: '독립 장면', intent: '' },
          { op: 'create', level: 'episode', title: '독립 회차', intent: '' },
        ],
      },
      'user'
    );
    expect(created.created).toHaveLength(3);
    const independent = find(store, chat.id, '독립 회차');
    expect(independent.parentId).toBeNull();
    const other = createFixtureChat(store, '다른 채팅');
    for (const [owner, parentId, level] of [
      [chat.id, independent.id, 'theme'],
      [chat.id, independent.id, 'episode'],
      [other.id, theme.id, 'beat'],
    ] as const)
      expect(
        failure(() =>
          store.outline.apply(
            owner,
            {
              idempotencyKey: randomUUID(),
              operations: [{ op: 'create', parentId, level, title: '거절', intent: '' }],
            },
            'user'
          )
        ).statusCode
      ).toBe(400);
  });

  test('duplicate refs and late mixed-operation errors reject the whole batch', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '배치 원자성 검사');
    const create = { op: 'create', ref: 'same', level: 'theme', title: '계획', intent: '' };
    expect(
      failure(() =>
        store.outline.apply(
          chat.id,
          {
            idempotencyKey: randomUUID(),
            operations: [create, { ...create, title: '다른 계획' }],
          },
          'user'
        )
      ).statusCode
    ).toBe(400);
    expect(store.outline.detail(chat.id).nodes).toEqual([]);
    expect(
      failure(() =>
        store.outline.apply(
          chat.id,
          {
            idempotencyKey: randomUUID(),
            operations: [
              create,
              {
                op: 'create',
                level: 'episode',
                parentRef: 'missing',
                title: '잘못된 회차',
                intent: '',
              },
            ],
          },
          'user'
        )
      ).statusCode
    ).toBe(400);
    expect(store.outline.detail(chat.id).nodes).toEqual([]);
    const [node] = store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [create],
      },
      'user'
    ).detail.nodes;
    expect(
      failure(() =>
        store.outline.apply(
          chat.id,
          {
            idempotencyKey: randomUUID(),
            operations: [
              { op: 'update', id: node.id, expectedRevision: node.revision, title: '롤백할 수정' },
              { op: 'remove', id: node.id, expectedRevision: node.revision },
            ],
          },
          'user'
        )
      ).statusCode
    ).toBe(409);
    expect(store.outline.node(node.id)).toEqual(node);
  });

  test('a completed batch can be confirmed after later edits or deletion without replaying writes', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '과거 요청 재확인');
    const createBody = {
      idempotencyKey: randomUUID(),
      operations: [{ op: 'create', level: 'theme', title: '처음 계획', intent: '' }],
    };
    const first = store.outline.apply(chat.id, createBody, 'user');
    const node = first.detail.nodes[0];
    const updateBody = {
      idempotencyKey: randomUUID(),
      operations: [
        { op: 'update', id: node.id, expectedRevision: node.revision, title: '사용자 정정' },
      ],
    };
    store.outline.apply(chat.id, updateBody, 'user');
    expect(store.outline.apply(chat.id, updateBody, 'user').detail.nodes[0].revision).toBe(2);
    const removeBody = {
      idempotencyKey: randomUUID(),
      operations: [{ op: 'remove', id: node.id, expectedRevision: 2 }],
    };
    store.outline.apply(chat.id, removeBody, 'user');
    expect(store.outline.apply(chat.id, removeBody, 'user').detail.nodes).toEqual([]);
    expect(store.outline.apply(chat.id, createBody, 'user')).toEqual({
      detail: { ...first.detail, nodes: [] },
      created: first.created,
    });
  });

  test('requested plan edits preserve authored keep flags and actual prose, while active runs and deletions remain protected', async () => {
    const store = await database(),
      chat = createFixtureChat(store, '실제 원문 보호');
    compose(store, chat.id);
    const arc = find(store, chat.id, '지하 서고의 발견'),
      beat = find(store, chat.id, '열쇠 없는 자물쇠');
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [{ op: 'update', id: beat.id, expectedRevision: beat.revision, fixed: true }],
      },
      'user'
    );
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [{ op: 'move', id: arc.id, expectedRevision: arc.revision, position: 10 }],
      },
      'user'
    );
    expect(store.outline.node(beat.id).fixed).toBe(true);
    const command = store.outline.sceneCommand(beat.id, { idempotencyKey: randomUUID() });
    const run = reserve(store, chat.id, command.id);
    store.startRun(run.id);
    const current = store.outline.node(beat.id);
    expect(
      failure(() =>
        store.outline.apply(
          chat.id,
          {
            idempotencyKey: randomUUID(),
            operations: [
              { op: 'update', id: beat.id, expectedRevision: current.revision, intent: '다르게' },
            ],
          },
          'user'
        )
      ).statusCode
    ).toBe(409);
    const source = store.completeRun(
      run.id,
      '구멍이 없었다.',
      { modelCalls: 1, inputTokens: 10, outputTokens: 20, costUsd: null },
      run.snapshot.settings
    );
    const written = store.outline.node(beat.id);
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'update',
            id: beat.id,
            expectedRevision: written.revision,
            intent: '현재 계획만 변경',
          },
        ],
      },
      'user'
    );
    expect(store.source(source.id).text).toBe('구멍이 없었다.');
    const updated = store.outline.node(arc.id);
    expect(
      failure(() =>
        store.outline.apply(
          chat.id,
          {
            idempotencyKey: randomUUID(),
            operations: [{ op: 'remove', id: arc.id, expectedRevision: updated.revision }],
          },
          'user'
        )
      ).statusCode
    ).toBe(409);
  });

  test('scene-command acknowledgement can be replayed after its run commits', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '집필 응답 유실 검사');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문');
    const key = randomUUID();
    const command = store.outline.sceneCommand(episode.id, { idempotencyKey: key });
    const completed = write(store, chat.id, command.id, '문은 잠겨 있었다.');
    expect(store.outline.sceneCommand(episode.id, { idempotencyKey: key })).toMatchObject({
      id: command.id,
      runId: completed.run.id,
      status: 'consumed',
    });
    expect(store.detail(chat.id).runs).toHaveLength(1);
    expect(
      failure(() =>
        store.outline.sceneCommand(episode.id, {
          idempotencyKey: key,
          request: '다른 집필 요청',
        })
      ).statusCode
    ).toBe(409);
  });

  test('long authored plans and explicit scene requests stay intact through reservation and replay', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '긴 집필 계획');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문');
    const intent = '장면의 세부 전개\n'.repeat(2500) + '계획의 끝';
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [{ op: 'update', id: episode.id, expectedRevision: episode.revision, intent }],
      },
      'user'
    );
    expect(store.outline.node(episode.id).intent).toBe(intent);
    const key = randomUUID();
    const generated = store.outline.sceneCommand(episode.id, { idempotencyKey: key });
    expect(generated.request).toBe(`회차 집필 요청: ${episode.title}\n${intent}`);
    expect(
      store.outline.sceneCommand(episode.id, { idempotencyKey: key, request: generated.request })
    ).toEqual(generated);
    const next = find(store, chat.id, '2화 장부의 첫 장');
    const request = '명시한 집필 요청\n'.repeat(2500) + '요청의 끝';
    const explicit = { idempotencyKey: randomUUID(), request };
    const command = store.outline.sceneCommand(next.id, explicit);
    expect(command.request).toBe(request);
    expect(store.outline.sceneCommand(next.id, explicit)).toEqual(command);
    expect(store.detail(chat.id).runs).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('a scene-command key cannot bind an identically named second unit', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '장면 요청 소유 검사');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문');
    const second = store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'create',
            parentId: episode.parentId,
            level: 'episode',
            title: episode.title,
            intent: episode.intent,
          },
        ],
      },
      'user'
    ).created[0].id;
    const key = randomUUID();
    store.outline.sceneCommand(episode.id, { idempotencyKey: key });
    expect(
      failure(() => store.outline.sceneCommand(second, { idempotencyKey: key })).statusCode
    ).toBe(409);
    expect(store.outline.node(second).progress.state).toBe('planned');
    expect(store.story.detail(chat.id).commands).toHaveLength(1);
  });

  test.each([
    ['target', '1화 잠긴 문'],
    ['ancestor', '지하 서고의 발견'],
    ['direct child', '열쇠 없는 자물쇠'],
  ])(
    'a changed %s plan rejects the old reservation and a fresh reservation uses the new plan',
    async (_, title) => {
      const store = await database();
      const chat = chatWithMainModel(store, '예약 뒤 구성 변경');
      compose(store, chat.id);
      const episode = find(store, chat.id, '1화 잠긴 문');
      const key = randomUUID();
      const old = store.outline.sceneCommand(episode.id, { idempotencyKey: key });
      const target = find(store, chat.id, title);
      store.outline.apply(
        chat.id,
        {
          idempotencyKey: randomUUID(),
          operations: [
            {
              op: 'update',
              id: target.id,
              expectedRevision: target.revision,
              intent: '예약 뒤 확정한 새로운 계획',
            },
          ],
        },
        'user'
      );
      expect(store.story.command(old.id)).toMatchObject({
        status: 'cancelled',
        request: old.request,
        runId: null,
      });
      expect(store.outline.sceneCommand(episode.id, { idempotencyKey: key }).id).toBe(old.id);
      expect(failure(() => reserve(store, chat.id, old.id)).statusCode).toBe(409);
      expect(store.detail(chat.id).runs).toEqual([]);
      expect(store.db.prepare('SELECT id FROM attempts').all()).toEqual([]);
      const fresh = store.outline.sceneCommand(episode.id, { idempotencyKey: randomUUID() });
      expect(fresh.id).not.toBe(old.id);
      // The old command stays cancelled even after a new command owns the outline node.
      expect(failure(() => reserve(store, chat.id, old.id)).statusCode).toBe(409);
      const { run } = write(store, chat.id, fresh.id, '새 계획으로 집필한 원문');
      expect(JSON.stringify(run.snapshot.outline)).toContain('예약 뒤 확정한 새로운 계획');
      const input = JSON.stringify(
        buildMainProviderRequest(await prepareNativeRisuReadOnly(run.snapshot, 'context')).request
      );
      expect(input).toContain('예약 뒤 확정한 새로운 계획');
      expect(input).not.toContain(target.intent);
      expect(store.story.command(old.id).request).toBe(old.request);
    }
  );

  test('an accepted run is replayed with its original plan after later composition edits', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '접수된 집필 응답 재확인');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문');
    const commandKey = randomUUID();
    const command = store.outline.sceneCommand(episode.id, { idempotencyKey: commandKey });
    const runKey = randomUUID();
    const run = reserve(store, chat.id, command.id, runKey);
    const original = JSON.parse(
      (store.db.prepare('SELECT command FROM runs WHERE id=?').get(run.id) as { command: string })
        .command
    );
    const arc = find(store, chat.id, '지하 서고의 발견');
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'update',
            id: arc.id,
            expectedRevision: arc.revision,
            intent: '이미 접수된 Run 이후 계획',
          },
        ],
      },
      'user'
    );
    expect(store.story.command(command.id).status).toBe('pending');
    const replay = () =>
      store.createRun(chat.id, { ...original, idempotencyKey: runKey }, () => {
        throw new Error('Replaying an accepted run must not compile a new snapshot');
      });
    expect(replay()).toMatchObject({ created: false, run: { id: run.id, snapshot: run.snapshot } });
    store.startRun(run.id);
    store.completeRun(
      run.id,
      '원래 계획으로 집필한 원문',
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings
    );
    expect(replay().run.id).toBe(run.id);
    expect(observedExecution(store, run.id).snapshot.outline).toEqual(run.snapshot.outline);
    expect(store.run(run.id).inputs).toEqual([]);
    expect(store.outline.sceneCommand(episode.id, { idempotencyKey: commandKey }).runId).toBe(
      run.id
    );
    expect(store.detail(chat.id).runs).toHaveLength(1);
  });

  test('only the committed final plan cancels a reservation, not intermediate edits or rolled-back batches', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '배치 최종 계획 비교');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문');
    const command = store.outline.sceneCommand(episode.id, { idempotencyKey: randomUUID() });
    const node = store.outline.node(episode.id);
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'update',
            id: node.id,
            expectedRevision: node.revision,
            intent: '배치 안의 임시 수정',
          },
          { op: 'update', id: node.id, expectedRevision: node.revision + 1, intent: node.intent },
        ],
      },
      'user'
    );
    expect(store.story.command(command.id).status).toBe('pending');
    const current = store.outline.node(node.id);
    expect(
      failure(() =>
        store.outline.apply(
          chat.id,
          {
            idempotencyKey: randomUUID(),
            operations: [
              {
                op: 'update',
                id: node.id,
                expectedRevision: current.revision,
                intent: '롤백해야 할 변경',
              },
              {
                op: 'create',
                level: 'beat',
                parentRef: 'missing',
                title: '실패할 항목',
                intent: '',
              },
            ],
          },
          'user'
        )
      ).statusCode
    ).toBe(400);
    expect(store.outline.node(node.id)).toEqual(current);
    expect(store.story.command(command.id)).toMatchObject({
      status: 'pending',
      request: command.request,
    });
    const { run } = write(store, chat.id, command.id, '최종 계획이 같은 원문');
    expect(run.snapshot.outline?.path.at(-1)?.intent).toBe(node.intent);
    expect(run.snapshot.outline?.path.at(-1)?.revision).toBe(current.revision);
  });

  test('the largest allowed batch commits once, and an oversized batch commits nothing', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '배치 한도 검사');
    const operations = Array.from({ length: 200 }, (_, index) => ({
      op: 'create',
      ref: `root-${index}`,
      level: 'theme',
      title: `계획 ${index}`,
      intent: '',
    }));
    const body = { idempotencyKey: randomUUID(), operations };
    const applied = store.outline.apply(chat.id, body, 'user');
    expect(applied.created).toHaveLength(200);
    expect(store.outline.apply(chat.id, body, 'user').created).toEqual(applied.created);
    expect(
      failure(() =>
        store.outline.apply(
          chat.id,
          {
            idempotencyKey: randomUUID(),
            operations: [...operations, { ...operations[0], ref: 'extra' }],
          },
          'user'
        )
      ).statusCode
    ).toBe(400);
    expect(store.outline.detail(chat.id).nodes).toHaveLength(200);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM outline_batches').get()).toMatchObject({
      count: 1,
    });
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

    const { request } = buildMainProviderRequest(
      await prepareNativeRisuReadOnly(run.snapshot, 'context')
    );
    const sent = JSON.stringify(request);
    expect(sent).toContain('사서가 도서관 지하에서 자기 이름이 적힌 장부를 찾아요.');
    expect(sent).toContain('열쇠 없는 자물쇠');
    expect(request.stable.contract).toContain(OUTLINE_CONTRACT);

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
    const { input } = buildMainProviderRequest(
      await prepareNativeRisuReadOnly(run.snapshot, 'context')
    );
    expect(input.contract).toContain(OUTLINE_CONTRACT);
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

  test('a keep-condition remains user editable without changing its children or prose', async () => {
    const store = await database(),
      chat = createFixtureChat(store, '유지 조건');
    compose(store, chat.id);
    const node = find(store, chat.id, '3화 관장의 방문');
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [{ op: 'update', id: node.id, expectedRevision: node.revision, fixed: true }],
      },
      'user'
    );
    const pinned = store.outline.node(node.id);
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'update',
            id: node.id,
            expectedRevision: pinned.revision,
            intent: '명시 요청으로 결말 변경',
          },
        ],
      },
      'user'
    );
    expect(store.outline.node(node.id)).toMatchObject({
      fixed: true,
      intent: '명시 요청으로 결말 변경',
    });
    expect(store.product.branch(chat.id).headRevision).toBeNull();
  });

  test('continuation keeps each actual source and preserves parent-child association without semantic completion', async () => {
    const store = await database(),
      chat = createFixtureChat(store, '나누어 쓰기');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문'),
      beat = find(store, chat.id, '열쇠 없는 자물쇠');
    const first = store.outline.sceneCommand(beat.id, { idempotencyKey: randomUUID() });
    const one = write(store, chat.id, first.id, '자물쇠를 발견했다.');
    const second = store.outline.sceneCommand(beat.id, { idempotencyKey: randomUUID() });
    expect(second.request).toContain('이어 쓰기');
    const two = write(store, chat.id, second.id, '문 뒤에서 작은 소리가 났다.');
    expect(store.outline.node(beat.id).writings?.map((source) => source.sourceRevision)).toEqual([
      one.source.id,
      two.source.id,
    ]);
    expect(store.outline.node(episode.id).progress.state).toBe('planned');
    expect(store.outline.preview(episode.id).outline.sources).toHaveLength(2);
    const parentCommand = store.outline.sceneCommand(episode.id, { idempotencyKey: randomUUID() });
    const next = reserve(store, chat.id, parentCommand.id);
    expect(next.snapshot.outline?.sources).toHaveLength(2);
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

  test('adding detail beneath a keep-condition does not rewrite the parent', async () => {
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
    expect(store.outline.node(pinned.id)).toMatchObject({ fixed: true, intent: pinned.intent });
  });
  test('explicit related plans reach the brief without recursive expansion and stale reservations are invalidated', async () => {
    const store = await database(),
      chat = createFixtureChat(store, '관련 계획');
    compose(store, chat.id);
    const first = find(store, chat.id, '1화 잠긴 문'),
      second = find(store, chat.id, '2화 장부의 첫 장'),
      third = find(store, chat.id, '3화 관장의 방문');
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          { op: 'update', id: first.id, expectedRevision: first.revision, relatedIds: [second.id] },
          {
            op: 'update',
            id: second.id,
            expectedRevision: second.revision,
            relatedIds: [third.id],
          },
        ],
      },
      'user'
    );
    const brief = store.outline.preview(first.id);
    expect(brief.outline.related?.map((node) => node.id)).toEqual([second.id]);
    expect(JSON.stringify(brief.outline)).not.toContain(third.id);
    const command = store.outline.sceneCommand(first.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: brief.expectedRevision,
      expectedPlanHash: brief.planHash,
    });
    const newer = store.outline.node(second.id);
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'update',
            id: second.id,
            expectedRevision: newer.revision,
            intent: '소리를 먼저 들려줘요.',
          },
        ],
      },
      'user'
    );
    expect(store.story.command(command.id).status).toBe('cancelled');
    expect(
      failure(() =>
        store.outline.sceneCommand(first.id, {
          idempotencyKey: randomUUID(),
          expectedPlanHash: brief.planHash,
        })
      ).statusCode
    ).toBe(409);
    const foreignChat = createFixtureChat(store, '다른 작품');
    compose(store, foreignChat.id);
    const foreign = find(store, foreignChat.id, '1화 잠긴 문');
    for (const ref of [first.id, foreign.id])
      expect(
        failure(() =>
          store.outline.apply(
            chat.id,
            {
              idempotencyKey: randomUUID(),
              operations: [
                {
                  op: 'update',
                  id: first.id,
                  expectedRevision: store.outline.node(first.id).revision,
                  relatedIds: [ref],
                },
              ],
            },
            'user'
          )
        ).statusCode
      ).toBe(400);
  });

  test('independent copies remap related plans and only source associations within the copied past', async () => {
    const { captureChatCopy, restoreChatCopy } = await import('../server/chat-copy.js');
    const store = await database(),
      chat = createFixtureChat(store, '원본');
    compose(store, chat.id);
    const first = find(store, chat.id, '1화 잠긴 문'),
      second = find(store, chat.id, '2화 장부의 첫 장');
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          { op: 'update', id: first.id, expectedRevision: first.revision, relatedIds: [second.id] },
        ],
      },
      'user'
    );
    const one = write(
      store,
      chat.id,
      store.outline.sceneCommand(first.id, { idempotencyKey: randomUUID() }).id,
      '첫 번째 원문'
    );
    write(
      store,
      chat.id,
      store.outline.sceneCommand(second.id, { idempotencyKey: randomUUID() }).id,
      '두 번째 원문'
    );
    const copy = captureChatCopy(store, chat.id, undefined, one.source.id);
    expect(copy.state.authoring?.outlineSources).toHaveLength(1);
    const restored = restoreChatCopy(store, copy, randomUUID(), '독립 사본');
    const copiedFirst = find(store, restored.id, first.title),
      copiedSecond = find(store, restored.id, second.title);
    expect(copiedFirst.id).not.toBe(first.id);
    expect(copiedFirst.relatedIds).toEqual([copiedSecond.id]);
    expect(copiedFirst.writings).toHaveLength(1);
    expect(copiedFirst.writings![0].sourceRevision).not.toBe(one.source.id);
    expect(store.source(copiedFirst.writings![0].sourceRevision).text).toBe('첫 번째 원문');
    expect(copiedSecond.writings).toEqual([]);
    expect(
      store.db.prepare('SELECT count(*) AS n FROM scene_commands WHERE chat_id=?').get(restored.id)
        ?.n
    ).toBe(0);
    expect(store.outline.node(first.id).relatedIds).toEqual([second.id]);
  });
});
