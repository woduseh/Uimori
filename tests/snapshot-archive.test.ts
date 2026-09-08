import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { mapForkSnapshot, validateRunSnapshot } from '../server/snapshot-archive.js';
import type { Content, PromptPreset } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { forkChat } from '../server/chat-fork.js';
import { chatDeletionImpact, deleteChat } from '../server/chat-deletion.js';
import { createApp } from '../server/app.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { createSourceSegmentFixture } from './fixtures/source-segments.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { directory: string; store: Store; close?: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    if (item.close) await item.close();
    else item.store.close();
    const target = resolve(item.directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-snapshot-archive-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-snapshot-archive-'));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
}
async function fixture(withSegments = false) {
  const store = await database();
  const chat = createFixtureChat(store, 'Synthetic snapshot archive');
  store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    status: false,
    translation: false,
  });
  if (withSegments) {
    const module = store.product.content({
      kind: 'module',
      title: 'Synthetic segment package',
      description: '',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: {
        version: 1,
        id: 'draft',
        revision: 1,
        title: 'Synthetic segment package',
        description: '',
        lore: [],
        instructions: [],
        controls: [],
        transforms: [],
        sourceSegments: createSourceSegmentFixture({ excludeAsides: true }),
      },
    }) as Content;
    const { chatId: _chatId, revision, ...profile } = store.product.profile(chat.id);
    store.product.updateProfile(chat.id, {
      ...profile,
      expectedRevision: revision,
      packageAttachments: [
        ...(profile.packageAttachments ?? []),
        { id: module.id, revision: module.revision, role: 'module' },
      ],
    });
  }
  function complete(request: string, text: string) {
    const current = store.chat(chat.id);
    const profile = store.product.snapshot(chat.id);
    const { run } = store.createRun(
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
        history: store.history(captured.headRevision),
        resources: store.product.resources(chat.id, profile),
        ...(profile ? { profile } : {}),
      })
    );
    store.startRun(run.id);
    const source = store.completeRun(
      run.id,
      text,
      { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      run.snapshot.settings
    );
    return { source, run: store.run(run.id) };
  }
  const first = complete(
    'First user request.',
    withSegments
      ? 'First main.\n@hsTitle: Private aside\nImmutable aside.\n@hs\nLast main.'
      : 'First immutable source.'
  );
  const second = complete('Second user request.', 'Second immutable source.');
  return { store, chat, first, second, complete };
}

test('ordinary Runs retain archived logical-history and compiled-prompt validation', async () => {
  const { store, second } = await fixture();
  const snapshot = second.run.snapshot;
  expect(() => validateRunSnapshot(store, snapshot)).not.toThrow();
  const changedHistory = structuredClone(snapshot);
  changedHistory.logicalHistory![0].text = 'Forged user request.';
  expect(() => validateRunSnapshot(store, changedHistory)).toThrow('logical history mismatch');
  const changedPrompt = structuredClone(snapshot);
  changedPrompt.promptCompilation!.messages[0].content[0].text = 'Forged compiled message.';
  expect(() => validateRunSnapshot(store, changedPrompt)).toThrow('compiled prompt mismatch');
  const missingPrompt = structuredClone(snapshot);
  delete missingPrompt.promptCompilation;
  expect(() => validateRunSnapshot(store, missingPrompt)).toThrow('compiled prompt missing');
});

test('ordinary fork remapping preserves text and hashes while rebinding history, summary, cache and trace identities', async () => {
  const { first, second } = await fixture();
  const snapshot = structuredClone(second.run.snapshot);
  const historyMessage = snapshot.promptCompilation!.messages.find(
    (message) => message.provenance.origin === 'history' && message.role === 'assistant'
  )!;
  const oldMessageId = historyMessage.id;
  const content = structuredClone(historyMessage.content),
    provenanceHash = historyMessage.provenance.sourceHash;
  snapshot.promptCompilation!.cachePlan.push({
    blockId: 'history-cache',
    afterMessageId: oldMessageId,
    policy: 'prefer',
  });
  snapshot.contextPlan = {
    version: 1,
    status: 'ready',
    budget: { inputTokenLimit: 8192, estimator: 'o200k_base-v1' },
    dependencyKey: 'synthetic-dependency',
    estimatedInputTokens: 100,
    compacted: [{ revision: first.source.id, hash: first.source.hash, viewHash: 'a'.repeat(64) }],
    recentSourceRevisions: [first.source.id],
    summary: 'Synthetic summary.',
    summaryCalls: 1,
    usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: null },
    error: null,
  };
  const missing = structuredClone(snapshot);
  expect(() => mapForkSnapshot(missing, new Map(), new Map())).toThrow('fork source dependency');
  mapForkSnapshot(
    snapshot,
    new Map([[first.source.id, 'fork-source']]),
    new Map([[first.run.id, 'fork-run']])
  );
  expect(
    snapshot.logicalHistory!.map((item) => [item.sourceRevision, item.runId, item.sourceHash])
  ).toEqual([
    ['fork-source', 'fork-run', first.source.hash],
    ['fork-source', 'fork-run', first.source.hash],
  ]);
  expect(snapshot.contextPlan.compacted).toEqual([
    { revision: 'fork-source', hash: first.source.hash, viewHash: 'a'.repeat(64) },
  ]);
  expect(snapshot.contextPlan.recentSourceRevisions).toEqual(['fork-source']);
  expect(historyMessage.content).toEqual(content);
  expect(historyMessage.provenance).toMatchObject({
    sourceRevision: 'fork-source',
    runId: 'fork-run',
    sourceHash: provenanceHash,
  });
  expect(historyMessage.id).not.toBe(oldMessageId);
  expect(snapshot.promptCompilation!.cachePlan.at(-1)!.afterMessageId).toBe(historyMessage.id);
  expect(snapshot.promptCompilation!.trace.flatMap((item) => item.messageIds)).toContain(
    historyMessage.id
  );
  expect(snapshot.promptCompilation!.trace.flatMap((item) => item.messageIds)).not.toContain(
    oldMessageId
  );
});

test('source policies stay frozen after detaching a package and archive validation rejects deleted or forged policies', async () => {
  const { store, chat, first, second, complete } = await fixture(true);
  const firstPolicy = structuredClone(first.run.snapshot.sourceSegments);
  expect(firstPolicy?.rules.some((rule) => rule.kind === 'aside' && rule.exclude)).toBe(true);
  expect(second.run.snapshot.history[0].sourceSegments).toEqual(firstPolicy);
  const { chatId: _chatId, revision, ...profile } = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    ...profile,
    expectedRevision: revision,
    packageAttachments: profile.packageAttachments?.filter((ref) => ref.role !== 'module') ?? [],
  });
  const third = complete('Continue after detaching the module.', 'Third immutable source.');
  expect(third.run.snapshot.sourceSegments).toBeUndefined();
  expect(third.run.snapshot.history[0].sourceSegments).toEqual(firstPolicy);
  expect(store.run(first.run.id).snapshot.sourceSegments).toEqual(firstPolicy);
  expect(() => validateRunSnapshot(store, third.run.snapshot)).not.toThrow();
  const removedCurrent = structuredClone(second.run.snapshot);
  delete removedCurrent.sourceSegments;
  expect(() => validateRunSnapshot(store, removedCurrent)).toThrow(
    'source segment policy mismatch'
  );
  const removedHistory = structuredClone(third.run.snapshot);
  delete removedHistory.history[0].sourceSegments;
  expect(() => validateRunSnapshot(store, removedHistory)).toThrow(
    'history source segment policy mismatch'
  );
  const forgedHistory = structuredClone(third.run.snapshot);
  forgedHistory.history[0].sourceSegments!.rules[0].exclude = false;
  expect(() => validateRunSnapshot(store, forgedHistory)).toThrow(
    'history source segment policy mismatch'
  );
  const archive = store.product.export();
  const restored = await database();
  expect(restored.product.import(archive)).toEqual({ restored: true, chats: 1 });
  expect(restored.run(third.run.id).snapshot.history[0].sourceSegments).toEqual(firstPolicy);
  const forged = structuredClone(archive),
    row = forged.tables.runs.find((item) => item.id === third.run.id)!;
  const snapshot = JSON.parse(row.snapshot as string);
  delete snapshot.history[0].sourceSegments;
  row.snapshot = JSON.stringify(snapshot);
  const rejected = await database();
  expect(() => rejected.product.import(forged)).toThrow();
  expect(rejected.chats()).toEqual([]);
});

async function candidateFixture() {
  const state = await fixture();
  const program = createDefaultPromptProgram('Synthetic branch-sensitive submission.');
  program.execution = {
    storySubmission: {
      when: {
        op: 'equal',
        args: [{ context: ['chat', 'branchId'] }, state.store.product.branch(state.chat.id).id],
      },
    },
  };
  const prompt = state.store.product.promptPreset({
    title: 'Frozen execution fixture',
    role: 'main',
    program,
  }) as PromptPreset;
  const { chatId: _chatId, revision, ...profile } = state.store.product.profile(state.chat.id);
  state.store.product.updateProfile(state.chat.id, {
    ...profile,
    expectedRevision: revision,
  });
  updatePromptWorkspace(state.store, {
    expectedRevision: promptWorkspace(state.store).revision,
    main: { title: prompt.title, program: prompt.program, values: prompt.values ?? {} },
  });
  const original = state.complete(
    'Request with a branch-sensitive execution condition.',
    'Original branch-sensitive source.'
  );
  const before = structuredClone(original.run.snapshot);
  const queued = state.store.candidate(original.run.id, randomUUID(), 'Frozen input candidate').run;
  state.store.startRun(queued.id);
  const source = state.store.completeRun(
    queued.id,
    'Alternative source from the same frozen input.',
    { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    queued.snapshot.settings
  );
  return { ...state, original, before, candidate: state.store.run(queued.id), source };
}

test('candidate archive keeps the original branch-dependent compilation and a fork remains independently restorable', async () => {
  const { store, chat, original, before, candidate, source } = await candidateFixture();
  expect(candidate.snapshot.branchId).not.toBe(original.run.snapshot.branchId);
  expect(candidate.snapshot.promptCompilation).toEqual(before.promptCompilation);
  expect(candidate.snapshot.promptCompilation?.execution).toEqual({ storySubmission: true });
  expect(() => validateRunSnapshot(store, candidate.snapshot)).not.toThrow();
  const restored = await database();
  expect(restored.product.import(store.product.export())).toEqual({ restored: true, chats: 1 });
  expect(restored.run(candidate.id).snapshot.promptCompilation).toEqual(before.promptCompilation);
  const forked = forkChat(restored, chat.id, {
    fromRevision: source.id,
    idempotencyKey: 'candidate-condition-fork',
  });
  expect(restored.source(forked.headRevision!).text).toBe(source.text);
  expect(restored.run(original.run.id).snapshot).toEqual(before);
  expect(restored.run(candidate.id).snapshot.promptCompilation).toEqual(before.promptCompilation);
  deleteChat(restored, chat.id, chatDeletionImpact(restored, chat.id).request);
  expect(() => restored.run(original.run.id)).toThrow('Run not found');
  expect(() => restored.run(candidate.id)).toThrow('Run not found');
  const restoredFork = await database();
  expect(restoredFork.product.import(restored.product.export())).toEqual({
    restored: true,
    chats: 1,
  });
  expect(restoredFork.source(forked.headRevision!).text).toBe(source.text);
});

test('candidate archive rejects forged execution, substituted origins and altered frozen input atomically', async () => {
  const { store, candidate, second } = await candidateFixture();
  const foreignChat = createFixtureChat(store, 'Foreign candidate origin');
  const foreignProfile = store.product.snapshot(foreignChat.id);
  const foreign = store.createRun(
    foreignChat.id,
    {
      request: 'Foreign request',
      expectedRevision: null,
      expectedSettingsRevision: foreignChat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    () => ({
      chatId: foreignChat.id,
      parentRevision: null,
      settingsRevision: foreignChat.settingsRevision,
      settings: foreignChat.settings,
      request: 'Foreign request',
      history: [],
      resources: store.product.resources(foreignChat.id, foreignProfile),
      profile: foreignProfile,
    })
  ).run;
  store.finishRun(foreign.id, 'cancelled', 'Synthetic cancellation');
  const sourceArchive = store.product.export();
  for (const mutate of [
    (snapshot: RunSnapshot) => {
      snapshot.promptCompilation!.execution!.storySubmission = false;
    },
    (snapshot: RunSnapshot) => {
      snapshot.executionClock = { iso: '2030-01-01T00:00:00.000Z', unix: 1893456000 };
    },
    (snapshot: RunSnapshot) => {
      snapshot.candidateOf = second.run.id;
    },
    (snapshot: RunSnapshot) => {
      snapshot.candidateOf = candidate.id;
    },
    (snapshot: RunSnapshot) => {
      snapshot.candidateOf = foreign.id;
    },
  ]) {
    const archive = structuredClone(sourceArchive);
    const row = archive.tables.runs.find((item) => item.id === candidate.id)!;
    const snapshot = JSON.parse(row.snapshot as string) as RunSnapshot;
    mutate(snapshot);
    row.snapshot = JSON.stringify(snapshot);
    const rejected = await database();
    expect(() => rejected.product.import(archive)).toThrow();
    expect(rejected.chats()).toEqual([]);
    expect(rejected.db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  }
});

test.each(['ready', 'pending'] as const)(
  'HTTP candidate preserves source-time branch execution from a %s context and roundtrips',
  async (state) => {
    const { store, chat } = await fixture();
    const requests: Record<string, any>[] = [];
    const provider = await loopbackProvider(async (request, response) => {
      requests.push(JSON.parse(request.body));
      await writeSse(response, [
        {
          type: 'tool_delta',
          index: 0,
          id: 'final',
          name: 'story.submit',
          argumentsDelta: JSON.stringify({ content: 'Synthetic submitted source.' }),
        },
        { type: 'usage', inputTokens: 12, outputTokens: 6, costUsd: null },
        { type: 'done', reason: 'tool_calls' },
      ]);
    });
    const connection = store.product.connection({
      title: 'Candidate loopback',
      protocol: 'fixture-sse-v1',
      endpoint: provider.endpoint,
      enabled: true,
    }) as { id: string };
    const model = store.product.model({
      title: 'Candidate fixture',
      connectionId: connection.id,
      modelId: 'fixture-main',
      maxOutputTokens: 1024,
      inputTokenLimit: 16384,
      temperature: null,
    }) as { id: string };
    const program = createDefaultPromptProgram('Submit the synthetic scene.');
    program.execution = {
      storySubmission: {
        when: {
          op: 'equal',
          args: [{ context: ['chat', 'branchId'] }, store.product.branch(chat.id).id],
        },
      },
    };
    const prompt = store.product.promptPreset({
      title: 'Candidate HTTP fixture',
      role: 'main',
      program,
    }) as PromptPreset;
    const { chatId: _chatId, revision, ...profile } = store.product.profile(chat.id);
    store.product.updateProfile(chat.id, {
      ...profile,
      expectedRevision: revision,
      routes: { ...profile.routes, main: { id: model.id } },
    });
    updatePromptWorkspace(store, {
      expectedRevision: promptWorkspace(store).revision,
      main: { title: prompt.title, program: prompt.program, values: prompt.values ?? {} },
    });
    const owner = owned.find((item) => item.store === store)!;
    store.close();
    const app = await createApp({
      dbPath: join(owner.directory, 'story.sqlite'),
      buildId: 'candidate-scope-fixture',
      testMode: true,
      approvedOrigins: [provider.origin],
    });
    owner.store = app.store;
    owner.close = async () => {
      await app.close();
      await provider.close();
    };
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const post = async (path: string, body: unknown) => {
      const response = await fetch(url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return value;
    };
    if (state === 'pending') await post('/api/test/control', { action: 'hold', barrier: 'run' });
    const current = app.store.chat(chat.id);
    const queued = await post(`/api/chats/${chat.id}/runs`, {
      request: 'Continue the fixture.',
      expectedRevision: current.headRevision,
      expectedSettingsRevision: current.settingsRevision,
      expectedProfileRevision: app.store.product.profile(chat.id).revision,
      idempotencyKey: randomUUID(),
    });
    if (state === 'pending') {
      await post(`/api/runs/${queued.id}/cancel`, {});
      await post('/api/test/control', { action: 'release', barrier: 'run' });
    } else await expect.poll(() => app.store.run(queued.id).status).toBe('completed');
    const original = app.store.run(queued.id);
    const before = structuredClone(original.snapshot);
    const candidate = await post(`/api/runs/${queued.id}/candidate`, {
      idempotencyKey: randomUUID(),
      title: 'Same source-time scope',
    });
    await expect.poll(() => app.store.run(candidate.id).status).toBe('completed');
    const completed = app.store.run(candidate.id);
    expect(completed.snapshot.branchId).not.toBe(original.snapshot.branchId);
    expect(completed.snapshot.promptCompilation?.execution).toEqual({ storySubmission: true });
    expect(completed.snapshot.contextPlan).toMatchObject({
      status: 'ready',
      summaryCalls: 0,
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    expect(completed.usage.modelCalls).toBe(1);
    expect(app.store.run(queued.id).snapshot).toEqual(before);
    if (state === 'ready') {
      expect(completed.snapshot.promptCompilation).toEqual(before.promptCompilation);
      expect(requests[1]).toEqual(requests[0]);
    }
    const response = await fetch(url + '/api/export');
    expect(response.status).toBe(200);
    const restored = await database();
    expect(restored.product.import(await response.json())).toEqual({ restored: true, chats: 1 });
    expect(restored.run(candidate.id).snapshot.promptCompilation).toEqual(
      completed.snapshot.promptCompilation
    );
  }
);
