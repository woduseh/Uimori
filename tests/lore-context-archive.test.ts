import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeTool, syntheticResources } from '../core/provider.js';
import type { RunSnapshot } from '../core/types.js';
import { forkChat } from '../server/chat-fork.js';
import {
  historicalRunLoreReads,
  validateArchivedLoreContext,
} from '../server/lore-context-archive.js';
import { compileSnapshotPrompt } from '../server/prompt-snapshot.js';
import { HttpError, Store } from '../server/store.js';
import { runStoryJob } from '../server/story-runner.js';

const owned: { store: Store; dir: string }[] = [];
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('External calls forbidden in lore archive tests'))
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-lore-archive-'))
      throw Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-lore-archive-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}
function createLoreChat(store: Store, title: string) {
  const input = fixtureBotInput(title);
  input.package.lore = syntheticResources('fixture')
    .filter((resource) => resource.kind === 'lore')
    .map((resource) => ({
      id: resource.id.slice('fixture:'.length),
      title: resource.title,
      description: resource.description,
      text: resource.text,
      loading: 'discoverable' as const,
    }));
  const bot = store.product.content(input);
  const chat = createFixtureChat(store, title, 'calm', { botId: bot.id });
  const resources = store.product.resources(chat.id, store.product.snapshot(chat.id));
  return { chat, id: resources.find((resource) => resource.id.endsWith(':harbor'))!.id };
}
function queued(store: Store, chatId: string, options: { loreContextReset?: boolean } = {}) {
  const chat = store.chat(chatId),
    profile = store.product.snapshot(chatId),
    request = 'Synthetic request ' + randomUUID();
  return store.createRun(
    chatId,
    {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
      ...options,
    },
    (current) => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request,
      history: store.history(current.headRevision),
      resources: store.product.resources(chatId, profile),
      ...(profile ? { profile } : {}),
    })
  ).run;
}
function complete(
  store: Store,
  chatId: string,
  reads: { id: string; offset: number; limit: number }[] = [],
  text = 'Synthetic exact source.'
) {
  const run = queued(store, chatId);
  store.startRun(run.id);
  for (const [index, args] of reads.entries())
    store.tool(
      run.id,
      executeTool(run.snapshot, { name: 'knowledge.read', callId: `read-${index}`, args })
    );
  const source = store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  return store.run(source.runId);
}
function fixture(store = database()) {
  const { chat, id } = createLoreChat(store, 'Synthetic lore archive');
  const first = complete(
    store,
    chat.id,
    [{ id, offset: 0, limit: 30 }],
    'The first synthetic source.'
  );
  const second = complete(
    store,
    chat.id,
    [{ id, offset: 20, limit: 30 }],
    'The second synthetic source.'
  );
  const third = complete(store, chat.id, [], 'The third synthetic source.');
  expect(third.snapshot.loreContext!.entries.map((entry) => [entry.start, entry.end])).toEqual([
    [0, 30],
    [30, 50],
  ]);
  return { store, chat, first, second, third, id };
}
function standalone(store: Store, chatId: string) {
  const archive = store.product.export(),
    runIds = new Set(
      archive.tables.runs.filter((row) => row.chat_id === chatId).map((row) => row.id)
    ),
    jobIds = new Set(
      archive.tables.jobs.filter((row) => row.chat_id === chatId).map((row) => row.id)
    ),
    sourceIds = new Set(
      archive.tables.sources.filter((row) => row.chat_id === chatId).map((row) => row.id)
    );
  for (const [name, rows] of Object.entries(archive.tables)) {
    if (name === 'versions' || name === 'package_behavior_entropy') continue;
    archive.tables[name] = rows.filter((row) =>
      Object.hasOwn(row, 'chat_id')
        ? row.chat_id === chatId
        : Object.hasOwn(row, 'run_id')
          ? runIds.has(row.run_id)
          : Object.hasOwn(row, 'job_id')
            ? jobIds.has(row.job_id)
            : Object.hasOwn(row, 'source_id')
              ? sourceIds.has(row.source_id)
              : name === 'chats'
                ? row.id === chatId
                : false
    );
  }
  return archive;
}
function tamperRun(
  archive: ReturnType<Store['product']['export']>,
  id: string,
  update: (snapshot: RunSnapshot) => void
) {
  const row = archive.tables.runs.find((item) => item.id === id)!;
  const snapshot = JSON.parse(row.snapshot) as RunSnapshot;
  update(snapshot);
  // Recompile so failures test read authority and provenance, not only a stale compiled prompt.
  row.snapshot = JSON.stringify(
    compileSnapshotPrompt({ ...snapshot, promptCompilation: undefined })
  );
}

test('a fork preserves verified ranges and mapped provenance with no copied execution log; its archive works without the original chat', () => {
  const f = fixture(),
    original = structuredClone(f.third.snapshot);
  const copy = forkChat(f.store, f.chat.id, {
    fromRevision: f.third.sourceRevision,
    idempotencyKey: 'read-fork',
  });
  const sources = f.store.history(copy.headRevision),
    copiedFirst = f.store.run(f.store.sourceOriginal(sources[0].revision).runId),
    copiedThird = f.store.run(f.store.sourceOriginal(sources[2].revision).runId);
  expect(copiedFirst.toolEvents).toEqual([]);
  expect(copiedThird.toolEvents).toEqual([]);
  expect(copiedFirst.snapshot.forkedLoreReads!.entries[0]).toMatchObject({
    start: 0,
    end: 30,
    text: f.first.snapshot.resources.find((item) => item.id === f.id)!.text.slice(0, 30),
    origin: { runId: copiedFirst.id, sourceRevision: copiedFirst.sourceRevision },
  });
  expect(copiedFirst.snapshot.forkedLoreReads!.entries[0].id).toBe(f.id);
  expect(copiedFirst.snapshot.resources.find((resource) => resource.id === f.id)).toMatchObject({
    chatId: copy.id,
    revision: f.first.snapshot.resources.find((resource) => resource.id === f.id)!.revision,
  });
  expect(copiedFirst.id).not.toBe(f.first.id);
  expect(copiedFirst.sourceRevision).not.toBe(f.first.sourceRevision);
  expect(
    copiedThird.snapshot.loreContext!.entries.map((entry) => [entry.start, entry.end])
  ).toEqual([
    [0, 30],
    [30, 50],
  ]);
  expect(f.store.run(f.third.id).snapshot).toEqual(original);
  const restored = database();
  expect(restored.product.import(standalone(f.store, copy.id))).toEqual({
    restored: true,
    chats: 1,
  });
  expect(restored.detail(copy.id).sources).toHaveLength(3);
  const next = complete(restored, copy.id);
  expect(next.snapshot.loreContext!.entries).toEqual(copiedThird.snapshot.loreContext!.entries);
  expect(next.snapshot.loreContext!.stats.retainedChars).toBe(50);
  const copiedAgain = forkChat(restored, copy.id, {
    fromRevision: next.sourceRevision,
    idempotencyKey: 'fork-again',
  });
  const independent = database();
  expect(independent.product.import(standalone(restored, copiedAgain.id))).toEqual({
    restored: true,
    chats: 1,
  });
  expect(complete(independent, copiedAgain.id).snapshot.loreContext!.stats.retainedChars).toBe(50);
});

test('archive rejects snapshot-only read, range, source and recency forgeries and rolls back all imported rows', () => {
  const f = fixture();
  const changes: ((snapshot: RunSnapshot) => void)[] = [
    (snapshot) => {
      snapshot.loreContext!.entries[0].origin.callId = 'never-called';
    },
    (snapshot) => {
      snapshot.loreContext!.entries[0].origin.sourceHash = '0'.repeat(64);
    },
    (snapshot) => {
      snapshot.loreContext!.entries[0].lastUsed = f.third.sourceRevision!;
    },
    (snapshot) => {
      const entry = snapshot.loreContext!.entries[1],
        resource = snapshot.resources.find((item) => item.id === entry.id)!;
      entry.end = 60;
      entry.text = resource.text.slice(entry.start, entry.end);
      snapshot.loreContext!.stats.retainedChars += 10;
    },
    (snapshot) => {
      const entry = snapshot.loreContext!.entries[0],
        resource = snapshot.resources.find((item) => item.id.endsWith(':observatory'))!;
      Object.assign(entry, {
        id: resource.id,
        revision: resource.revision,
        title: resource.title,
        text: resource.text.slice(0, 30),
      });
    },
  ];
  for (const change of changes) {
    const archive = f.store.product.export();
    tamperRun(archive, f.third.id, change);
    const target = database(),
      before = target.product.export().tables;
    expect(() => target.product.import(archive)).toThrow(HttpError);
    expect(target.product.export().tables).toEqual(before);
  }
});

test('archive cannot resurrect an ancestor read after the immediate parent reset and performed no new read', () => {
  const store = database();
  const { chat, id } = createLoreChat(store, 'Synthetic reset transition');
  const first = complete(store, chat.id, [{ id, offset: 0, limit: 30 }]);
  const reset = queued(store, chat.id, { loreContextReset: true });
  store.startRun(reset.id);
  store.completeRun(
    reset.id,
    'Synthetic source after explicit reset.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    reset.snapshot.settings
  );
  const next = complete(store, chat.id);
  expect(next.snapshot.loreContext!.entries).toEqual([]);
  const archive = store.product.export();
  tamperRun(archive, next.id, (snapshot) => {
    snapshot.loreContext!.entries = historicalRunLoreReads(store, first);
    Object.assign(snapshot.loreContext!.stats, {
      retainedChars: 30,
      retainedEntries: 1,
      appendedChars: 30,
    });
  });
  const target = database(),
    before = target.product.export().tables;
  expect(() => target.product.import(archive)).toThrow(
    'retained entry outside immediate parent transition'
  );
  expect(target.product.export().tables).toEqual(before);
});

test('archive cannot resurrect an evicted read when a later policy provides more capacity', () => {
  const store = database(),
    chat = createFixtureChat(store, 'Synthetic eviction transition');
  const a = store.product.content({
    kind: 'lore',
    title: 'Synthetic first lore',
    description: '',
    text: 'A synthetic first reference has several characters.',
    loading: 'discoverable',
    relatedIds: [],
  });
  const b = store.product.content({
    kind: 'lore',
    title: 'Synthetic second lore',
    description: '',
    text: 'A synthetic second reference has several characters.',
    loading: 'discoverable',
    relatedIds: [],
  });
  const { chatId: _chatId, revision, ...body } = store.product.profile(chat.id);
  const policy = {
    enabled: true,
    maxRetainedChars: 1000,
    maxRetainedEntries: 1,
    maxPinnedChars: 200000,
  };
  store.product.updateProfile(chat.id, {
    ...body,
    expectedRevision: revision,
    attachments: [
      { id: a.id, revision: a.revision },
      { id: b.id, revision: b.revision },
    ],
    loreContext: policy,
  });
  complete(store, chat.id, [{ id: a.id, offset: 0, limit: 20 }]);
  const second = complete(store, chat.id, [{ id: b.id, offset: 0, limit: 20 }]),
    firstEntry = structuredClone(second.snapshot.loreContext!.entries[0]);
  const evicted = complete(store, chat.id);
  expect(evicted.snapshot.loreContext!.entries.map((entry) => entry.id)).toEqual([b.id]);
  expect(evicted.snapshot.loreContext!.stats.reasons).toContain('retention-budget');
  const {
    chatId: _sameChatId,
    revision: currentRevision,
    ...current
  } = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    ...current,
    expectedRevision: currentRevision,
    loreContext: { ...policy, maxRetainedEntries: 2 },
  });
  const next = complete(store, chat.id);
  expect(next.snapshot.loreContext!.entries.map((entry) => entry.id)).toEqual([b.id]);
  const archive = store.product.export();
  tamperRun(archive, next.id, (snapshot) => {
    snapshot.loreContext!.entries.unshift(firstEntry);
    Object.assign(snapshot.loreContext!.stats, {
      retainedChars: 40,
      retainedEntries: 2,
      appendedChars: 20,
    });
  });
  const target = database(),
    before = target.product.export().tables;
  expect(() => target.product.import(archive)).toThrow(
    'retained entry outside immediate parent transition'
  );
  expect(target.product.export().tables).toEqual(before);
});

test('a later context budget may keep whole ordered entries but cannot reorder or falsify their last use', () => {
  const f = fixture();
  const trimmed = f.store.product.export();
  tamperRun(trimmed, f.third.id, (snapshot) => {
    snapshot.loreContext!.entries = snapshot.loreContext!.entries.slice(1);
    Object.assign(snapshot.loreContext!.stats, {
      retainedChars: 20,
      retainedEntries: 1,
      droppedEntries: 1,
    });
  });
  const target = database();
  expect(target.product.import(trimmed).restored).toBe(true);
  expect(
    complete(target, f.chat.id).snapshot.loreContext!.entries.map((entry) => [
      entry.start,
      entry.end,
    ])
  ).toEqual([[30, 50]]);
  for (const change of [
    (snapshot: RunSnapshot) => {
      snapshot.loreContext!.entries.reverse();
    },
    (snapshot: RunSnapshot) => {
      snapshot.loreContext!.entries[0].lastUsed = f.first.sourceRevision!;
    },
  ]) {
    const forged = f.store.product.export();
    tamperRun(forged, f.third.id, change);
    const empty = database();
    expect(() => empty.product.import(forged)).toThrow(
      'retained entry outside immediate parent transition'
    );
    expect(empty.chats()).toEqual([]);
  }
});

test('fork receipts reject invented ownership, range and use as an ordinary run receipt', () => {
  const f = fixture(),
    copy = forkChat(f.store, f.chat.id, {
      fromRevision: f.third.sourceRevision,
      idempotencyKey: 'forged-fork',
    });
  const copiedFirst = f.store.run(
    f.store.sourceOriginal(f.store.history(copy.headRevision)[0].revision).runId
  );
  const changes: ((snapshot: RunSnapshot) => void)[] = [
    (snapshot) => {
      delete snapshot.forkedFrom;
    },
    (snapshot) => {
      snapshot.forkedLoreReads!.entries[0].origin.runId = f.first.id;
    },
    (snapshot) => {
      snapshot.forkedLoreReads!.entries[0].text = 'An invented read';
    },
    (snapshot) => {
      snapshot.forkedLoreReads!.dependencies = [
        {
          sourceRevision: f.third.sourceRevision!,
          sourceHash: f.store.sourceOriginal(f.third.sourceRevision!).hash,
        },
      ];
    },
  ];
  for (const change of changes) {
    const archive = standalone(f.store, copy.id);
    tamperRun(archive, copiedFirst.id, change);
    const target = database();
    expect(() => target.product.import(archive)).toThrow(HttpError);
    expect(target.chats()).toEqual([]);
  }
});

test('source edits preserve historical archive proof but invalidate inherited reads in a standalone fork continuation', () => {
  const f = fixture(),
    historical = structuredClone(f.third.snapshot);
  f.store.editSource(f.first.sourceRevision!, {
    expectedRevision: 0,
    text: 'User replacement of the first source.',
  });
  expect(() => validateArchivedLoreContext(f.store, historical)).not.toThrow();
  const archiveTarget = database();
  expect(archiveTarget.product.import(f.store.product.export())).toEqual({
    restored: true,
    chats: 1,
  });
  const copy = forkChat(f.store, f.chat.id, {
    fromRevision: f.third.sourceRevision,
    idempotencyKey: 'edited-fork',
  });
  const restored = database();
  expect(restored.product.import(standalone(f.store, copy.id))).toEqual({
    restored: true,
    chats: 1,
  });
  const next = complete(restored, copy.id);
  expect(next.snapshot.loreContext!.entries).toEqual([]);
  expect(next.snapshot.loreContext!.stats.reasons).toContain('source-or-canon-changed');
  expect(f.store.run(f.third.id).snapshot).toEqual(historical);
});

test('authored canon identities remap for a fresh fork, while a later retcon cannot revive past reads', () => {
  const store = database();
  const { chat, id } = createLoreChat(store, 'Synthetic canon scope');
  const declaration = store.story.memory.authored(chat.id, {
    text: 'The synthetic beacon is blue.',
    author: 'Synthetic author',
  });
  complete(store, chat.id, [{ id, offset: 0, limit: 30 }]);
  const second = complete(store, chat.id);
  const copy = forkChat(store, chat.id, {
    fromRevision: second.sourceRevision,
    idempotencyKey: 'canon-fork',
  });
  const copiedHead = store.run(store.sourceOriginal(copy.headRevision!).runId);
  expect(copiedHead.snapshot.loreContext!.canonHash).not.toBe(
    second.snapshot.loreContext!.canonHash
  );
  const restored = database();
  restored.product.import(standalone(store, copy.id));
  expect(complete(restored, copy.id).snapshot.loreContext!.stats.retainedChars).toBe(30);
  store.story.memory.authored(
    chat.id,
    { text: 'The synthetic beacon is now red.', author: 'Synthetic author' },
    declaration.id
  );
  const afterRetcon = forkChat(store, chat.id, {
    fromRevision: second.sourceRevision,
    idempotencyKey: 'retcon-fork',
  });
  const retconTarget = database();
  retconTarget.product.import(standalone(store, afterRetcon.id));
  expect(complete(retconTarget, afterRetcon.id).snapshot.loreContext!.entries).toEqual([]);
});

test('a changed canon at the root keeps historical fork contexts invalid instead of stamping them with current canon', () => {
  const f = fixture(),
    oldCanon = f.third.snapshot.loreContext!.canonHash;
  const root = f.store.product.createBranch(f.chat.id, {
    title: 'Synthetic retcon root',
    fromRevision: null,
  });
  f.store.story.memory.authored(f.chat.id, {
    text: 'Synthetic root declaration added after those reads.',
    author: 'Synthetic author',
    branchId: root.id,
  });
  const copy = forkChat(f.store, f.chat.id, {
    fromRevision: f.third.sourceRevision,
    idempotencyKey: 'changed-root-canon',
  });
  const copied = f.store.run(f.store.sourceOriginal(copy.headRevision!).runId);
  expect(copied.snapshot.loreContext!.canonHash).not.toBe(oldCanon);
  expect(copied.snapshot.loreContext!.canonHash).not.toBe(
    f.store.story.memory.canonHash(f.store.story.memory.scope(copy.id, copied.parentRevision))
  );
  const restored = database();
  restored.product.import(standalone(f.store, copy.id));
  expect(complete(restored, copy.id).snapshot.loreContext!.entries).toEqual([]);
});

test('an authoritative state wait resumes with the same retained read provenance before compiling the main prompt', async () => {
  const store = database();
  const { chat, id } = createLoreChat(store, 'Synthetic waiting lore');
  store.story.saveConfig(chat.id, {
    expectedRevision: 0,
    module: {
      id: 'synthetic-coins',
      revision: 1,
      name: 'Synthetic coins',
      mode: 'authoritative',
      fields: { coins: { type: 'number', initial: 10, min: 0, max: 100 } },
      rules: {},
    },
    stateModel: null,
    memory: { enabled: false, model: null, recentCount: 2, maxPacketChars: 60000 },
  });
  const first = complete(store, chat.id, [{ id, offset: 0, limit: 30 }]);
  const waiting = queued(store, chat.id);
  expect(waiting.status).toBe('waiting_for_state');
  expect(waiting.snapshot.promptCompilation).toBeUndefined();
  expect(waiting.snapshot.loreContext!.stats.retainedChars).toBe(30);
  const job = store.story
    .detail(chat.id)
    .jobs.find((item) => item.sourceRevision === first.sourceRevision && item.kind === 'state')!;
  const claim = store.story.claim(job.id, 'synthetic-lore-worker')!;
  const result = await runStoryJob(store.story.bundle(job.id), {
    signal: new AbortController().signal,
    approvedOrigins: [],
    authorize: (connection) => connection,
    onAttemptStart: () => {
      throw new Error('No real provider attempt allowed');
    },
    onAttemptFinish: () => {},
    onInput: () => {},
    onToolEvent: () => {},
  });
  expect(result.status).toBe('completed');
  store.story.finish(job.id, claim.generation, 'synthetic-lore-worker', result);
  expect(store.story.resumeWaiting()).toEqual([waiting.id]);
  const resumed = store.run(waiting.id);
  expect(resumed.snapshot.loreContext).toEqual(waiting.snapshot.loreContext);
  expect(resumed.snapshot.promptCompilation).toBeDefined();
  expect(JSON.stringify(resumed.snapshot.promptCompilation)).toContain(
    'Previously read reference data'
  );
  const restored = database();
  expect(restored.product.import(store.product.export()).restored).toBe(true);
  expect(restored.run(waiting.id).status).toBe('interrupted');
  store.startRun(resumed.id);
  const second = store.completeRun(
    resumed.id,
    'Synthetic source after state wait.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    resumed.snapshot.settings
  );
  const secondJob = store.story
      .detail(chat.id)
      .jobs.find((item) => item.sourceRevision === second.id && item.kind === 'state')!,
    secondClaim = store.story.claim(secondJob.id, 'synthetic-lore-worker')!;
  const secondResult = await runStoryJob(store.story.bundle(secondJob.id), {
    signal: new AbortController().signal,
    approvedOrigins: [],
    authorize: (connection) => connection,
    onAttemptStart: () => {
      throw new Error('No real provider attempt allowed');
    },
    onAttemptFinish: () => {},
    onInput: () => {},
    onToolEvent: () => {},
  });
  expect(secondResult.status).toBe('completed');
  store.story.finish(secondJob.id, secondClaim.generation, 'synthetic-lore-worker', secondResult);
  const copy = forkChat(store, chat.id, {
      fromRevision: second.id,
      idempotencyKey: 'copy-state-lore',
    }),
    copyMain = store.run(store.sourceOriginal(copy.headRevision!).runId);
  const copyJob = store.story
      .detail(copy.id)
      .jobs.find((item) => item.sourceRevision === copy.headRevision && item.kind === 'state')!,
    jobSnapshot = store.story.bundle(copyJob.id).snapshot;
  for (const field of [
    'loreContext',
    'loreContextReset',
    'forkedLoreReads',
    'logicalHistory',
    'promptCompilation',
  ] as const)
    expect(jobSnapshot[field]).toEqual(copyMain.snapshot[field]);
  const metadata = JSON.stringify([
    jobSnapshot.loreContext,
    jobSnapshot.forkedLoreReads,
    jobSnapshot.logicalHistory,
    jobSnapshot.promptCompilation,
  ]);
  expect(metadata).not.toContain(chat.id);
  expect(metadata).not.toContain(first.sourceRevision!);
  expect(metadata).not.toContain(first.id);
  expect(metadata).not.toContain(second.id);
  const independent = database();
  expect(independent.product.import(standalone(store, copy.id)).restored).toBe(true);
});
