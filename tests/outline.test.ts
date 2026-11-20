import { observeExecutions, observedExecution } from './fixtures/execution-observer.js';
import { prepareNativeRisuReadOnly } from '../server/risu-native-readonly.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createFixtureChat } from './fixtures/chat.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { Store } from '../server/store.js';
import type { HttpError } from '../server/request-validation.js';

import { buildMainProviderRequest } from '../server/main-request.js';
import { OUTLINE_CONTRACT, OUTLINE_FOCUS_CONTRACT, OUTLINE_LEVEL_LABELS } from '../core/outline.js';
import type { RunSnapshot, Source } from '../core/types.js';
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
    routes: { main: { id: model.id }, translation: null },
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

function reserve(store: Store, chatId: string, commandId: string, key = randomUUID()) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const command = store.story.command(commandId);
  return store.createRun(
    chatId,
    {
      request: command.request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: store.product.profile(chatId).revision,
      idempotencyKey: key,
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

function ordinary(store: Store, chatId: string, text: string, replace?: Source) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const parent = replace ? replace.parentRevision : chat.headRevision;
  const { run } = store.createRun(
    chatId,
    {
      request: '이어서 써 주세요.',
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      expectedProfileRevision: store.product.profile(chatId).revision,
      idempotencyKey: randomUUID(),
    },
    (current) =>
      ({
        chatId,
        parentRevision: parent,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request: '이어서 써 주세요.',
        history: store.history(parent),
        resources: store.product.resources(chatId, profile),
        ...(profile ? { profile } : {}),
        ...(replace
          ? { replacement: { sourceRevision: replace.id, sourceHash: replace.hash } }
          : {}),
      }) satisfies RunSnapshot
  );
  store.startRun(run.id);
  const source = store.completeRun(run.id, text, {
    modelCalls: 1,
    inputTokens: 10,
    outputTokens: 20,
    costUsd: null,
  });
  return { run: observedExecution(store, run.id), source };
}

function write(store: Store, chatId: string, commandId: string, text: string) {
  const run = reserve(store, chatId, commandId);
  store.startRun(run.id);
  const source = store.completeRun(run.id, text, {
    modelCalls: 1,
    inputTokens: 10,
    outputTokens: 20,
    costUsd: null,
  });
  return { run: observedExecution(store, run.id), source };
}

describe('hierarchical composition', () => {
  test('composes five levels without writing any prose', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '구성 검사');
    const before = store.chat(chat.id).headRevision;
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
    expect(detail.nodes.every((node) => node.progress.state === 'planned')).toBe(true);
    expect(store.chat(chat.id).headRevision).toBe(before);
  });

  test('allows skipped levels and standalone units but rejects inversions, cross-chat parents, and writing above episodes', async () => {
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
    const arc = find(store, chat.id, '지하 서고의 발견');
    const error = failure(() =>
      store.outline.sceneCommand(arc.id, { idempotencyKey: randomUUID() })
    );
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain(OUTLINE_LEVEL_LABELS.episode);
  });

  test('duplicate refs, late mixed-operation errors, and oversized batches reject the whole batch', async () => {
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
    expect(store.outline.detail(chat.id).nodes).toHaveLength(201);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM outline_batches').get()).toMatchObject({
      count: 2,
    });
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
    const source = store.completeRun(run.id, '구멍이 없었다.', {
      modelCalls: 1,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: null,
    });
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
    expect(store.source(source.id).hash).toBe(source.hash);
    expect(store.outline.node(beat.id)).toMatchObject({ fixed: true, intent: '현재 계획만 변경' });
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
    expect(
      failure(() => store.outline.sceneCommand(second, { idempotencyKey: key })).statusCode
    ).toBe(409);
    expect(store.outline.node(second).progress.state).toBe('planned');
    expect(store.story.commands(chat.id)).toHaveLength(1);
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
    expect(generated.request).toBe('Write the selected outline unit.');
    expect(generated.request).not.toContain(intent);
    expect(
      store.outline.sceneCommand(episode.id, { idempotencyKey: key, request: generated.request })
    ).toEqual(generated);
    const legacyRequest = '선택한 구성에 따라 이 단위를 집필해 주세요.';
    store.db
      .prepare('UPDATE scene_commands SET request=? WHERE id=?')
      .run(legacyRequest, generated.id);
    for (const idempotencyKey of [key, randomUUID()]) {
      expect(
        store.outline.sceneCommand(episode.id, { idempotencyKey, additionalInstruction: '' })
          .request
      ).toBe(legacyRequest);
    }
    const next = find(store, chat.id, '2화 장부의 첫 장');
    const request = '명시한 집필 요청\n'.repeat(2500) + '요청의 끝';
    const explicit = { idempotencyKey: randomUUID(), request };
    const command = store.outline.sceneCommand(next.id, explicit);
    expect(command.request).toBe(request);
    expect(store.outline.sceneCommand(next.id, explicit)).toEqual(command);
    expect(store.detail(chat.id).runs).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('additional instructions stay separate from the plan and both freeze for admitted writing', async () => {
    const store = await database();
    const chat = createFixtureChat(store, '구성과 추가 지시');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문');
    const preview = store.outline.preview(episode.id);
    const input = {
      idempotencyKey: randomUUID(),
      additionalInstruction: '대화 위주로 쓰고 문을 열기 전에 멈춰 주세요.',
      expectedRevision: preview.expectedRevision,
      expectedPlanHash: preview.planHash,
    };
    const command = store.outline.sceneCommand(episode.id, input);
    expect(command.request).toBe(input.additionalInstruction);
    expect(command.request).not.toContain(episode.intent);
    const { run } = write(store, chat.id, command.id, '문 앞의 대화.');
    expect(run.snapshot.request).toBe(command.request);
    expect(run.snapshot.outline?.path.at(-1)?.intent).toBe(episode.intent);
    expect(store.outline.sceneCommand(episode.id, input).id).toBe(command.id);
    expect(
      failure(() =>
        store.outline.sceneCommand(episode.id, {
          ...input,
          additionalInstruction: '다른 지시',
        })
      ).statusCode
    ).toBe(409);
    const latest = store.outline.node(episode.id);
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'update',
            id: episode.id,
            expectedRevision: latest.revision,
            intent: '접수 뒤 새 계획',
          },
        ],
      },
      'user'
    );
    expect(run.snapshot.outline?.path.at(-1)?.intent).toBe(episode.intent);
    expect(run.snapshot.request).toBe(command.request);
  });

  test.each([
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
    store.completeRun(run.id, '원래 계획으로 집필한 원문', {
      modelCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
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

  test('large detail reads preserve source projections and archive bytes without exposing retired reviews', async () => {
    const { HelperWorkspace } = await import('../server/helper-workspace.js');
    const store = await database();
    const chat = createFixtureChat(store, '구성 일괄 조회');
    compose(store, chat.id);
    const initial = store.outline.nodes(chat.id);
    const episode = initial.find((node) => node.title === '1화 잠긴 문')!;
    const beat = initial.find((node) => node.parentId === episode.id)!;
    const second = initial.find((node) => node.title === '2화 장부의 첫 장')!;
    const third = initial.find((node) => node.title === '3화 관장의 방문')!;
    store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: [
          {
            op: 'update',
            id: episode.id,
            expectedRevision: episode.revision,
            relatedIds: [third.id, second.id],
          },
        ],
      },
      'user'
    );
    const command = store.outline.sceneCommand(episode.id, { idempotencyKey: randomUUID() });
    const { run, source } = write(store, chat.id, command.id, '문은 잠겨 있었다.');
    store.outline.sceneCommand(second.id, { idempotencyKey: randomUUID() });
    store.db
      .prepare(`INSERT INTO outline_writings(id,node_id,source_id,created_at)
      VALUES(?,?,?,?)`)
      .run(randomUUID(), beat.id, source.id, source.createdAt);
    const conversation = new HelperWorkspace(store).open({ kind: 'chat', chatId: chat.id });
    const time = '2026-01-01T00:00:00.000Z';
    const review = (nodeId: string, status = 'completed', partial = false) => {
      const taskId = randomUUID();
      const sources = store.outline.preview(nodeId).outline.sources!.map((item) => ({
        id: item.sourceRevision,
        hash: item.sourceHash,
        start: 0,
        end: source.text.length,
        total: source.text.length,
      }));
      store.db
        .prepare(`INSERT INTO helper_tasks(id,conversation_id,request_key,request,status,
        snapshot,usage,created_at,updated_at) VALUES(?,?,?,'review',?,'{}','{}',?,?)`)
        .run(taskId, conversation.id, taskId, status, time, time);
      store.db
        .prepare('INSERT INTO outline_reviews VALUES(?,?,?,?,?,?)')
        .run(
          taskId,
          nodeId,
          store.outline.planHash(nodeId),
          JSON.stringify(sources),
          Number(partial),
          time
        );
      return taskId;
    };
    for (const node of initial) review(node.id);
    const latestTask = review(episode.id, 'cancelled', true);
    const archivedReview = store.db
      .prepare('SELECT * FROM outline_reviews WHERE task_id=?')
      .get(latestTask);
    const prepare = vi.spyOn(store.db, 'prepare');
    const small = store.outline.detail(chat.id);
    const smallReads = prepare.mock.calls.length;
    expect(small.nodes.map((node) => node.id)).toEqual(initial.map((node) => node.id));
    expect(small.nodes.find((node) => node.id === episode.id)).toMatchObject({
      relatedIds: [third.id, second.id],
      progress: {
        state: 'written',
        commandId: command.id,
        runId: run.id,
        sourceRevision: source.id,
      },
    });
    expect(small.nodes.find((node) => node.id === second.id)?.progress.state).toBe('scheduled');
    expect(small.nodes.find((node) => node.id === third.id)?.progress.state).toBe('planned');
    const added = store.outline.apply(
      chat.id,
      {
        idempotencyKey: randomUUID(),
        operations: Array.from({ length: 200 }, (_, index) => ({
          op: 'create',
          level: 'theme',
          title: `추가 계획 ${index}`,
          intent: '',
        })),
      },
      'user'
    ).created;
    for (const node of added) review(node.id);
    const other = createFixtureChat(store, '다른 채팅');
    compose(store, other.id);
    prepare.mockClear();
    const large = store.outline.detail(chat.id);
    expect(prepare.mock.calls.length).toBe(smallReads);
    expect(large.nodes).toHaveLength(207);
    expect(large.nodes.slice(0, 7)).toEqual(small.nodes);
    expect(large.nodes.every((node) => !('latestReview' in node))).toBe(true);
    const edited = store.editSource(source.id, {
      expectedRevision: store.source(source.id).editRevision ?? 0,
      text: '문은 열려 있었다.',
    });
    prepare.mockClear();
    const changed = store.outline.detail(chat.id);
    expect(prepare.mock.calls.length).toBe(smallReads);
    const current = changed.nodes.find((node) => node.id === episode.id)!;
    expect(current.writings?.[0].sourceHash).toBe(edited.hash);
    expect(current).not.toHaveProperty('latestReview');
    expect(store.outline.preview(episode.id).outline.sources).toHaveLength(1);
    expect(
      store.db.prepare('SELECT * FROM outline_reviews WHERE task_id=?').get(latestTask)
    ).toEqual(archivedReview);
    for (const status of ['failed', 'cancelled', 'pending']) {
      store.db
        .prepare('UPDATE scene_commands SET status=?,source_revision=NULL WHERE id=?')
        .run(status, command.id);
      store.db.prepare("UPDATE runs SET status='queued' WHERE id=?").run(run.id);
      expect(
        store.outline.detail(chat.id).nodes.find((node) => node.id === episode.id)?.progress.state
      ).toBe(status === 'pending' ? 'writing' : status);
    }
  });

  test('writing one episode carries the upper intent into the real generation input and later siblings as history', async () => {
    const store = await database();
    const chat = chatWithMainModel(store, '집필 연결 검사');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문');
    const command = store.outline.sceneCommand(episode.id, { idempotencyKey: randomUUID() });
    expect(command.request).toBe('Write the selected outline unit.');
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
    expect(outline.path.at(-1)).toMatchObject({
      id: episode.id,
      title: episode.title,
      intent: episode.intent,
    });
    expect(outline.children.map((item) => item.title)).toEqual(['열쇠 없는 자물쇠']);
    expect(outline.neighbors).toEqual({
      next: expect.objectContaining({ title: '2화 장부의 첫 장' }),
    });
    expect(JSON.stringify({ ...outline, neighbors: undefined })).not.toContain('2화 장부의 첫 장');

    expect(outline.written).toEqual([]);
    const { request, input } = buildMainProviderRequest(
      await prepareNativeRisuReadOnly(run.snapshot, 'context')
    );
    const sent = JSON.stringify(request);
    expect(sent).toContain('사서가 도서관 지하에서 자기 이름이 적힌 장부를 찾아요.');
    expect(sent).toContain('열쇠 없는 자물쇠');
    expect(request.stable.contract).toContain(OUTLINE_CONTRACT);
    expect(input.contract).toContain(OUTLINE_CONTRACT);
    expect(store.story.detail(chat.id).notes).toEqual([]);
    expect(store.context.detail(chat.id).checkpoint).toBeNull();

    expect(store.chat(chat.id).headRevision).toBe(source.id);
    const nodes = store.outline.detail(chat.id).nodes;
    expect(nodes.find((node) => node.id === episode.id)?.progress).toMatchObject({
      state: 'written',
      sourceRevision: source.id,
    });
    expect(
      nodes.filter((node) => node.id !== episode.id).every((n) => n.progress.state === 'planned')
    ).toBe(true);

    const second = find(store, chat.id, '2화 장부의 첫 장');
    const secondCommand = store.outline.sceneCommand(second.id, { idempotencyKey: randomUUID() });
    const next = write(store, chat.id, secondCommand.id, '장부의 첫 장을 펼쳤다.');
    expect(next.run.snapshot.outline?.written).toEqual([
      {
        id: episode.id,
        level: 'episode',
        title: '1화 잠긴 문',
        sourceRevision: source.id,
      },
    ]);
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
    expect(second.request).toBe('Write the selected outline unit.');
    const two = write(store, chat.id, second.id, '문 뒤에서 작은 소리가 났다.');
    expect(two.run.snapshot.outline?.path.at(-1)?.id).toBe(beat.id);
    expect(two.run.snapshot.outline?.sources).toEqual([
      {
        nodeId: beat.id,
        sourceRevision: one.source.id,
        sourceHash: one.source.hash,
        origin: 'planned',
        current: true,
        createdAt: expect.any(String),
      },
    ]);
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
    expect(failure(() => store.story.command(command.id)).statusCode).toBe(404);
    expect(store.story.commands(chat.id)).toEqual([]);
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
    const copy = captureChatCopy(store, chat.id, one.source.id);
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

  test('an ordinary request continues inside the current unit, and its prose joins that unit', async () => {
    const { captureChatCopy, restoreChatCopy } = await import('../server/chat-copy.js');
    const store = await database();
    const chat = chatWithMainModel(store, '진행 중 플롯');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문');
    expect(store.outline.focus(chat.id)).toBeNull();
    const opening = ordinary(store, chat.id, '도서관의 아침이었다.');
    expect(opening.run.snapshot.outline).toBeUndefined();

    const planned = write(
      store,
      chat.id,
      store.outline.sceneCommand(episode.id, { idempotencyKey: randomUUID() }).id,
      '문은 잠겨 있었다.'
    );
    expect(store.outline.focus(chat.id)).toEqual({
      nodeId: episode.id,
      level: 'episode',
      title: episode.title,
    });

    const turn = ordinary(store, chat.id, '사서는 손잡이를 다시 당겼다.');
    const outline = turn.run.snapshot.outline;
    if (!outline) throw new Error('Expected the current unit as orientation');
    expect(outline.focus).toBe(true);
    expect(outline.path.at(-1)?.id).toBe(episode.id);
    expect(outline.neighbors?.next?.title).toBe('2화 장부의 첫 장');
    expect(outline.sources?.map((source) => source.sourceRevision)).toEqual([planned.source.id]);
    const { request } = buildMainProviderRequest(
      await prepareNativeRisuReadOnly(turn.run.snapshot, 'context')
    );
    expect(request.stable.contract).toContain(OUTLINE_FOCUS_CONTRACT);

    expect(
      store.outline.node(episode.id).writings?.map(({ sourceRevision, origin }) => ({
        sourceRevision,
        origin,
      }))
    ).toEqual([
      { sourceRevision: planned.source.id, origin: 'planned' },
      { sourceRevision: turn.source.id, origin: 'focus' },
    ]);
    const { outlineSceneTitles } = await import('../server/scene-titles.js');
    const titles = outlineSceneTitles(store, chat.id);
    expect(titles.get(planned.source.id)).toBe(episode.title);
    expect(titles.has(turn.source.id)).toBe(false);

    const restored = restoreChatCopy(
      store,
      captureChatCopy(store, chat.id, turn.source.id),
      randomUUID(),
      '진행 중 사본'
    );
    const copied = find(store, restored.id, episode.title);
    expect(store.outline.focus(restored.id)?.nodeId).toBe(copied.id);
    expect(copied.writings?.map((source) => source.origin)).toEqual(['planned', 'focus']);

    expect(store.outline.setFocus(chat.id, { nodeId: null })).toBeNull();
    expect(ordinary(store, chat.id, '바람이 불었다.').run.snapshot.outline).toBeUndefined();
    const other = createFixtureChat(store, '다른 채팅');
    expect(failure(() => store.outline.setFocus(other.id, { nodeId: episode.id })).statusCode).toBe(
      400
    );
  });

  test('source state follows the current branch while other branches stay linked', async () => {
    const store = await database();
    const chat = chatWithMainModel(store, '분기 원문');
    compose(store, chat.id);
    const beat = find(store, chat.id, '열쇠 없는 자물쇠'),
      episode = find(store, chat.id, '1화 잠긴 문');
    const opening = ordinary(store, chat.id, '도서관의 아침이었다.');
    const written = write(
      store,
      chat.id,
      store.outline.sceneCommand(beat.id, { idempotencyKey: randomUUID() }).id,
      '자물쇠를 발견했다.'
    );
    store.outline.setFocus(chat.id, { nodeId: null });
    const replaced = ordinary(store, chat.id, '문 앞에 아무것도 없었다.', written.source);
    expect(store.chat(chat.id).headRevision).toBe(replaced.source.id);
    expect(replaced.source.parentRevision).toBe(opening.source.id);
    expect(store.outline.node(beat.id).writings).toEqual([
      expect.objectContaining({ sourceRevision: written.source.id, current: false }),
    ]);
    expect(store.outline.preview(episode.id).outline.sources).toEqual([]);
    const review = failure(() =>
      store.outline.helperContext(
        chat.id,
        {
          nodeId: episode.id,
          expectedRevision: store.outline.node(episode.id).revision,
          purpose: 'review',
        },
        8192
      )
    );
    expect(review.statusCode).toBe(409);
  });

  test('a review starts from the latest current-branch sources', async () => {
    const store = await database();
    const chat = chatWithMainModel(store, '최근 원문 점검');
    compose(store, chat.id);
    const episode = find(store, chat.id, '1화 잠긴 문');
    const sources = ['첫째 장면', '둘째 장면', '셋째 장면', '넷째 장면'].map(
      (text) =>
        write(
          store,
          chat.id,
          store.outline.sceneCommand(episode.id, { idempotencyKey: randomUUID() }).id,
          text
        ).source
    );
    const context = store.outline.helperContext(
      chat.id,
      {
        nodeId: episode.id,
        expectedRevision: store.outline.node(episode.id).revision,
        purpose: 'review',
      },
      8192
    );
    expect(context.sources.map((source) => source.id)).toEqual(
      sources.slice(-3).map((source) => source.id)
    );
    expect(context.partial).toBe(true);
  });

  test('editing can change a level within its parent and children', async () => {
    const store = await database(),
      chat = createFixtureChat(store, '수준 바꾸기');
    compose(store, chat.id);
    const episode = find(store, chat.id, '2화 장부의 첫 장'),
      withChild = find(store, chat.id, '1화 잠긴 문');
    const change = (id: string, revision: number, level: string) =>
      store.outline.apply(
        chat.id,
        {
          idempotencyKey: randomUUID(),
          operations: [{ op: 'update', id, expectedRevision: revision, level }],
        },
        'user'
      );
    change(episode.id, episode.revision, 'beat');
    expect(store.outline.node(episode.id)).toMatchObject({
      level: 'beat',
      revision: episode.revision + 1,
    });
    expect(failure(() => change(episode.id, episode.revision + 1, 'mainStory')).statusCode).toBe(
      400
    );
    expect(failure(() => change(withChild.id, withChild.revision, 'beat')).statusCode).toBe(400);
  });
});
