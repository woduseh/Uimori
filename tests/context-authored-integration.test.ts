import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Connection, Content, ModelPreset } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { Store } from '../server/store.js';
import { createPackageStart } from '../server/package-start.js';
import { captureLogicalHistory } from '../server/prompt-snapshot.js';
import { prepareInputContext } from '../server/context-compaction.js';
import { buildMainProviderRequest } from '../server/main-request.js';
import { forkChat } from '../server/chat-fork.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const owned: { store: Store; dir: string }[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-authored-context-')
    )
      throw Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-authored-context-')),
    store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}
function currentSnapshot(
  store: Store,
  chatId: string,
  request = 'CURRENT_REQUEST: 미라의 선택은 대신 정하지 마세요.'
): RunSnapshot {
  const chat = store.chat(chatId),
    profile = store.product.snapshot(chatId)!;
  return {
    chatId,
    parentRevision: chat.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request,
    history: store.history(chat.headRevision),
    resources: store.product.resources(chatId, profile),
    profile,
  };
}
function nextRun(store: Store, chatId: string, request?: string) {
  const snapshot = currentSnapshot(store, chatId, request);
  return store.createRun(
    chatId,
    {
      request: snapshot.request,
      expectedRevision: snapshot.parentRevision,
      expectedSettingsRevision: snapshot.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    () => snapshot
  ).run;
}
function currentHistory(store: Store, chatId: string, base: RunSnapshot) {
  const chat = store.chat(chatId);
  return captureLogicalHistory(store, {
    ...base,
    chatId,
    parentRevision: chat.headRevision,
    history: store.history(chat.headRevision),
  });
}

test('real authored start and ordinary turns retain host provenance through compaction, edits, standalone forks and archive validation', async () => {
  type Fragment = { sourceRevision: string; sourceHash: string; role: string; text: string };
  const fragments: Fragment[] = [],
    failures: unknown[] = [];
  const server = await loopbackProvider(async (request, response) => {
    try {
      const body = JSON.parse(request.body);
      expect(body.role).toBe('context');
      expect(body.stable.tools).toEqual([]);
      expect(request.body).not.toContain('sourceKind');
      fragments.push(...body.input.source.fragments);
      await writeSse(response, [
        {
          type: 'text_delta',
          delta: '미라는 항구에 도착했고 약속의 진실은 불확실해요. 사용자의 선택은 보존해요.',
        },
        { type: 'usage', inputTokens: 11, outputTokens: 7 },
        { type: 'done', reason: 'stop' },
      ]);
    } catch (error) {
      failures.push(error);
      throw error;
    }
  });
  closes.push(server.close);
  const store = database(),
    opening =
      'AUTHORED_OPENING\n' +
      '비 오는 항구에서 미라는 약속을 기억해요. 진실인지 아직 알 수 없어요.\n'.repeat(450);
  const content = store.product.content({
    kind: 'module',
    title: 'Synthetic authored world',
    description: '',
    text: 'Synthetic only',
    loading: 'pinned',
    relatedIds: [],
    package: {
      version: 1,
      id: 'authored-world',
      revision: 1,
      title: 'Synthetic authored world',
      description: '',
      body: 'Synthetic only',
      lore: [],
      instructions: [],
      transforms: [],
      controls: [],
      starts: [{ id: 'arrival', title: '도착', mode: 'authored', text: opening }],
    },
  }) as Content;
  let chat = createFixtureChat(store, 'Synthetic authored context', 'calm', {
    botId: content.id,
  });
  chat = store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
    maxCalls: 16,
  });
  const connection = store.product.connection({
    title: 'Temporary loopback',
    protocol: 'fixture-sse-v1',
    endpoint: server.endpoint,
    enabled: true,
  }) as Connection;
  const model = store.product.model({
    title: 'Synthetic context model',
    connectionId: connection.id,
    modelId: 'fixture-main',
    maxOutputTokens: 8192,
    inputTokenLimit: 8192,
    temperature: null,
  }) as ModelPreset;
  const { chatId: _chatId, revision, ...profile } = store.product.profile(chat.id);
  const saved = updateTestProfile(store.product, chat.id, {
    ...profile,
    expectedRevision: revision,
    routes: { ...profile.routes, main: { id: model.id } },
  });
  const workspace = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: workspace.revision,
    routes: workspace.routes,
    translationPolicy: workspace.translationPolicy,
    contextModel: { id: model.id },
  });
  const authored = createPackageStart(store, chat.id, {
    packageId: content.id,
    packageRevision: content.revision,
    startId: 'arrival',
    expectedSettingsRevision: chat.settingsRevision,
    expectedProfileRevision: saved.revision,
    idempotencyKey: 'authored-opening',
  }).run;
  const authoredSource = store.source(authored.sourceRevision!);
  const ordinary = nextRun(
    store,
    chat.id,
    'ORDINARY_USER_REQUEST: 항구의 다음 장면을 이어 주세요.'
  );
  store.startRun(ordinary.id);
  const ordinarySource = store.completeRun(
    ordinary.id,
    'ORDINARY_ASSISTANT: 미라는 등불을 바라봤어요.',
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
    ordinary.snapshot.settings
  );
  const continuation = nextRun(store, chat.id),
    history = continuation.snapshot.logicalHistory!;
  expect(history).toEqual(captureLogicalHistory(store, continuation.snapshot));
  expect(history.filter((item) => item.sourceRevision === authoredSource.id)).toEqual([
    expect.objectContaining({
      role: 'assistant',
      text: opening,
      sourceHash: authoredSource.hash,
      runId: authored.id,
      sourceKind: 'authored-start',
    }),
  ]);
  expect(
    history
      .filter((item) => item.sourceRevision === ordinarySource.id)
      .map((item) => [item.role, item.sourceKind])
  ).toEqual([
    ['user', undefined],
    ['assistant', undefined],
  ]);
  store.startRun(continuation.id);
  const prepared = await prepareInputContext(continuation.snapshot, {
    signal: new AbortController().signal,
    approvedOrigins: [server.origin],
    authorize: (value) => store.product.authorize(value),
    onInput: () => {},
    onToolEvent: () => {},
    onProgress: () => {},
    onAttemptStart: (wire) => store.product.startAttempt(chat.id, continuation.id, null, wire),
    onAttemptFinish: (id, result) => store.product.finishAttempt(id, result),
  });
  expect(failures).toEqual([]);
  expect(fragments.length).toBeGreaterThan(0);
  expect(prepared.snapshot.contextPlan).toMatchObject({
    status: 'ready',
    compacted: [{ revision: authoredSource.id, hash: authoredSource.hash }],
    recentSourceRevisions: [ordinarySource.id],
  });
  expect(
    fragments.every(
      (part) =>
        part.sourceRevision === authoredSource.id &&
        part.sourceHash === authoredSource.hash &&
        part.role === 'assistant'
    )
  ).toBe(true);
  expect(fragments.map((part) => part.text).join('')).toBe(opening);
  const providerRequest = buildMainProviderRequest(prepared.snapshot).request;
  expect(
    providerRequest.prompt!.messages.every(
      (message) => !Object.hasOwn(message.provenance, 'sourceKind')
    )
  ).toBe(true);
  expect(JSON.stringify(providerRequest)).not.toContain('authored-start');
  store.db
    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
    .run(
      JSON.stringify(store.context.publishPrepared(prepared.snapshot, { origin: 'automatic' })),
      continuation.id
    );
  store.finishRun(
    continuation.id,
    'cancelled',
    'Synthetic test stops before main generation',
    '',
    prepared.usage
  );
  const edited = store.editSource(authoredSource.id, {
    text: 'EDITED_AUTHORED_OPENING: 미라는 새 항구에 도착했어요.',
    expectedRevision: 0,
  });
  const refreshed = currentHistory(store, chat.id, continuation.snapshot);
  expect(refreshed.find((item) => item.sourceRevision === authoredSource.id)).toMatchObject({
    sourceKind: 'authored-start',
    text: edited.text,
    sourceHash: edited.hash,
  });
  expect(store.run(continuation.id).snapshot.logicalHistory).toEqual(history);
  const fork = forkChat(store, chat.id, {
    fromRevision: ordinarySource.id,
    idempotencyKey: 'independent-authored-context-fork',
  });
  const forkHistory = currentHistory(store, fork.id, continuation.snapshot);
  expect(forkHistory.map((item) => [item.role, item.sourceKind])).toEqual([
    ['assistant', 'authored-start'],
    ['user', undefined],
    ['assistant', undefined],
  ]);
  expect(forkHistory[0]).toMatchObject({ text: edited.text, sourceHash: edited.hash });
  expect(forkHistory[0].runId).not.toBe(authored.id);
  const archive = store.product.export(),
    restored = database();
  expect(() => restored.product.import(archive)).not.toThrow();
  expect(currentHistory(restored, chat.id, continuation.snapshot)).toEqual(refreshed);
  const standalone = structuredClone(archive),
    forkSources = new Set(store.detail(fork.id).sources.map((source) => source.id));
  for (const [name, rows] of Object.entries(standalone.tables))
    standalone.tables[name] = rows.filter((row: any) =>
      name === 'chats'
        ? row.id === fork.id
        : Object.hasOwn(row, 'chat_id')
          ? row.chat_id === fork.id
          : Object.hasOwn(row, 'source_id')
            ? forkSources.has(row.source_id)
            : true
    );
  const independent = database();
  expect(independent.product.import(standalone)).toEqual({ restored: true, chats: 1 });
  expect(currentHistory(independent, fork.id, continuation.snapshot)).toEqual(forkHistory);
  const forged = structuredClone(archive),
    row = forged.tables.runs.find((item: any) => item.id === continuation.id)!;
  const forgedSnapshot = JSON.parse(row.snapshot);
  forgedSnapshot.logicalHistory.find(
    (item: any) => item.sourceRevision === ordinarySource.id && item.role === 'assistant'
  ).sourceKind = 'authored-start';
  row.snapshot = JSON.stringify(forgedSnapshot);
  const target = database(),
    before = target.product.export().tables;
  expect(() => target.product.import(forged)).toThrow('logical history mismatch');
  expect(target.product.export().tables).toEqual(before);
});
