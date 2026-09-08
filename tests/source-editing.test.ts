import { createFixtureChat } from './fixtures/chat.js';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import { runAuxiliaryJob, sourceTimeContext } from '../server/product-auxiliary.js';
import { createTranslationPlan } from '../core/auxiliary.js';
import { auxiliaryBridge } from '../server/auxiliary-bridge.js';
import { Controls } from '../server/controls.js';
const owned: { store?: Store; dir: string }[] = [];
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-edit-tests-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, dir } of owned.splice(0)) {
    store?.close();
    const rel = relative(resolve(tmpdir()), resolve(dir));
    if (isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith('uimori-edit-tests-'))
      throw new Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function source(
  store: Store,
  chatId = createFixtureChat(store, 'editing').id,
  text = 'Original paragraph.\n\nSecond paragraph.'
) {
  const chat = store.chat(chatId);
  const request = 'local';
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: chat.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (c) => ({
      chatId,
      parentRevision: c.headRevision,
      settingsRevision: c.settingsRevision,
      settings: c.settings,
      request,
      history: store.history(c.headRevision),
      resources: [],
    })
  ).run;
  store.startRun(run.id);
  return store.source(
    store.completeRun(
      run.id,
      text,
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings
    ).id
  );
}

function chunkSetting(store: Store, chatId: string, translationChunkChars: number | null) {
  const chat = store.chat(chatId);
  return store.settings(chatId, chat.settingsRevision, {
    ...chat.settings,
    translationChunkChars,
  });
}

async function translateFixture(store: Store, jobId: string) {
  await runAuxiliaryJob(
    auxiliaryBridge(store, new Controls(), new AbortController().signal),
    jobId,
    'chunk-setting-owner',
    {
      signal: new AbortController().signal,
      approvedOrigins: [],
      authorize: (c) => c,
      onAttemptStart: () => {
        throw new Error('Live forbidden');
      },
      onAttemptFinish: () => {},
    }
  );
  expect(store.job(jobId).status).toBe('completed');
}

test('new translation uses current chunk setting while an existing reservation remains frozen', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live forbidden'));
  const store = database();
  const chat = createFixtureChat(store, 'chunk settings');
  const s = source(store, chat.id, ['A'.repeat(150), 'B'.repeat(150)].join('\n\n'));
  const originalSnapshot = store.run(s.runId).snapshot;
  expect(store.requestTranslation(s.id).input).toMatchObject({ translationChunkChars: 3000 });
  const reserved = store.requestTranslation(s.id);
  chunkSetting(store, chat.id, 100);
  expect(store.requestTranslation(s.id).input).toEqual(reserved.input);
  await translateFixture(store, reserved.id);
  expect(store.product.plan(reserved.id).maxChunkChars).toBe(3000);
  expect(store.product.chunks(reserved.id)).toHaveLength(1);
  const split = store.retranslate(s.id);
  expect(split.input).toMatchObject({ translationChunkChars: 100 });
  await translateFixture(store, split.id);
  expect(store.product.plan(split.id).maxChunkChars).toBe(100);
  expect(store.product.chunks(split.id)).toHaveLength(2);
  chunkSetting(store, chat.id, null);
  expect(store.requestTranslation(s.id).revision).toBe(split.revision);
  const unlimited = store.retranslate(s.id);
  expect(unlimited.input).toMatchObject({ translationChunkChars: null });
  await translateFixture(store, unlimited.id);
  expect(store.product.plan(unlimited.id).maxChunkChars).toBeNull();
  expect(store.product.chunks(unlimited.id)).toHaveLength(1);
  expect(store.run(s.runId).snapshot).toEqual(originalSnapshot);
  expect(store.job(unlimited.id).sourceHash).toBe(s.hash);
});

test('explicit partial translation retry replaces completed chunks using the current setting', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live forbidden'));
  const store = database();
  const chat = createFixtureChat(store, 'partial chunk settings');
  chunkSetting(store, chat.id, 100);
  const s = source(store, chat.id, ['A'.repeat(150), 'B'.repeat(150)].join('\n\n'));
  const job = store.requestTranslation(s.id);
  const snapshot = store.product.resolveJobPrompt(store.run(s.runId).snapshot, job.input);
  const plan = createTranslationPlan(s, sourceTimeContext(snapshot, 'translation'), 100);
  const ownedJob = store.claimJob(job.id, 'partial-owner', {}, plan)!;
  const first = plan.chunks[0];
  const saved = {
    sourceRevision: s.id,
    sourceHash: s.hash,
    chunkId: first.id,
    segments: [{ anchors: first.anchors, text: '보존할 번역' }],
  };
  store.product.chunk(job.id, first.id, 'running');
  store.product.chunk(job.id, first.id, 'completed', undefined, saved);
  store.finishAuxiliary(job.id, ownedJob.generation, 'partial-owner', {
    status: 'partial',
    result: null,
    error: 'Synthetic failure after one completed chunk',
  });
  chunkSetting(store, chat.id, null);
  const prior = store.job(job.id);
  expect(() =>
    store.retryJob(job.id, () => {
      throw new Error('Synthetic invalid current model');
    })
  ).toThrow('Synthetic invalid current model');
  expect(store.job(job.id)).toEqual(prior);
  expect(store.product.plan(job.id)).toEqual(plan);
  const retried = store.retryJob(job.id);
  expect(retried.input).toMatchObject({ translationChunkChars: null });
  expect(retried.revision).toBe(prior.revision! + 1);
  expect(store.product.plan(job.id)).toBeNull();
  expect(store.product.chunks(job.id)).toHaveLength(0);
  expect(store.retryJob(job.id)).toEqual(retried);
  await translateFixture(store, job.id);
  expect(store.product.chunks(job.id)).toHaveLength(1);
  expect(store.product.plan(job.id).maxChunkChars).toBeNull();
  expect(store.job(job.id).input).toMatchObject({ translationChunkChars: null });
  expect(store.job(job.id).result?.text).not.toContain('보존할 번역');
});

test.each([100, null])(
  'archive and fork preserve translation chunk setting %s and reject inconsistent plans',
  async (limit) => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live forbidden'));
    const store = database();
    const chat = createFixtureChat(store, 'archive chunk settings');
    chunkSetting(store, chat.id, limit);
    const s = source(store, chat.id, ['A'.repeat(150), 'B'.repeat(150)].join('\n\n'));
    const job = store.requestTranslation(s.id);
    await translateFixture(store, job.id);
    const plan = store.product.plan(job.id);
    const archive = store.product.export();
    const restored = database();
    restored.product.import(archive);
    expect(restored.chat(chat.id).settings.translationChunkChars).toBe(limit);
    expect(restored.job(job.id).input).toMatchObject({ translationChunkChars: limit });
    expect(restored.product.plan(job.id)).toEqual(plan);
    const fork = forkChat(store, chat.id, { fromRevision: s.id, idempotencyKey: randomUUID() });
    expect(fork.settings.translationChunkChars).toBe(limit);
    const copied = store.detail(fork.id).jobs.find((item) => item.kind === 'translation')!;
    expect(copied.input).toMatchObject({ translationChunkChars: limit });
    expect(store.product.plan(copied.id)).toMatchObject({
      maxChunkChars: limit,
      sourceRevision: fork.headRevision,
      sourceHash: s.hash,
    });
    expect(store.product.chunks(copied.id)).toHaveLength(plan.chunks.length);
    const forged: any = structuredClone(archive);
    const row = forged.tables.jobs.find((item: any) => item.id === job.id);
    row.plan = JSON.stringify({
      ...JSON.parse(row.plan),
      maxChunkChars: limit === null ? 100 : null,
    });
    const target = database();
    expect(() => target.product.import(forged)).toThrow();
    expect(target.chats()).toHaveLength(0);
    const invalidSettings: any = structuredClone(archive);
    const chatRow = invalidSettings.tables.chats.find((item: any) => item.id === chat.id);
    chatRow.settings = JSON.stringify({
      ...JSON.parse(chatRow.settings),
      translationChunkChars: 99,
    });
    expect(() => database().product.import(invalidSettings)).toThrow();
  }
);
test('completion never reserves translation; manual save and demand remain free', () => {
  const store = database();
  const s = source(store);
  expect(store.detail(s.chatId).jobs.some((j) => j.kind === 'translation')).toBe(false);
  const manual = store.editTranslation(s.id, {
    text: '  Authored text  ',
    expectedRevision: 0,
    expectedSourceHash: s.hash,
  });
  expect(manual.result?.manual).toBe(true);
  expect(manual.result?.text).toBe('  Authored text  ');
  expect(store.requestTranslation(s.id).id).toBe(manual.id);
  expect(store.queuedJobs().includes(manual.id)).toBe(false);
  expect(store.product.attempts(s.chatId)).toHaveLength(0);
});
test('CAS manual edit fences a late owned job and keeps a single slot', () => {
  const store = database();
  const s = source(store);
  const job = store.requestTranslation(s.id);
  expect(store.requestTranslation(s.id).id).toBe(job.id);
  const active = store.claimJob(job.id, 'owner', {})!;
  const manual = store.editTranslation(s.id, {
    text: 'Manual',
    expectedRevision: job.revision!,
    expectedSourceHash: s.hash,
  });
  expect(store.completeJob(job.id, active.generation, 'owner', { text: 'late' })).toBe(false);
  expect(manual.generation).toBeGreaterThan(active.generation);
  expect(() =>
    store.editTranslation(s.id, {
      text: 'conflict',
      expectedRevision: job.revision!,
      expectedSourceHash: s.hash,
    })
  ).toThrow('conflict');
  const forced = store.retranslate(s.id);
  expect(forced.id).toBe(job.id);
  expect(forced.revision).toBeGreaterThan(manual.revision!);
  expect(store.detail(s.chatId).jobs.filter((j) => j.kind === 'translation')).toHaveLength(1);
});
test('source editing invalidates jobs and preserves both old and new snapshot history', () => {
  const store = database();
  const s = source(store);
  const child = source(store, s.chatId);
  const before = store.run(child.runId).snapshot;
  const job = store.requestTranslation(s.id);
  const active = store.claimJob(job.id, 'owner', {})!;
  const edited = store.editSource(s.id, { text: ' Updated \n\n Source ', expectedRevision: 0 });
  expect(edited.editRevision).toBe(1);
  expect(store.sourceOriginal(s.id).text).toBe(s.text);
  expect(store.sourceAtHash(s.id, s.hash).text).toBe(s.text);
  expect(store.validateHistory(before.history, s.id)).toBe(true);
  expect(store.history(s.id)[0].contentHash).toBe(edited.hash);
  expect(store.completeJob(job.id, active.generation, 'owner', {})).toBe(false);
  expect(store.job(job.id).status).toBe('stale');
  expect(store.detail(s.chatId).jobs.some((j) => j.id === job.id)).toBe(false);
  expect(() => store.editSource(s.id, { text: 'bad', expectedRevision: 0 })).toThrow('conflict');
  expect(store.editSource(s.id, { text: edited.text, expectedRevision: 1 }).editRevision).toBe(1);
  expect(store.requestTranslation(s.id).sourceHash).toBe(edited.hash);
});
test('versioned source restore and fork preserve edit history, manual translation and independent copies', () => {
  const store = database();
  const s = source(store);
  source(store, s.chatId);
  const edited = store.editSource(s.id, { text: 'Edited', expectedRevision: 0 });
  store.editTranslation(s.id, {
    text: 'Manual translation',
    expectedRevision: 0,
    expectedSourceHash: edited.hash,
  });
  const archive = store.product.export();
  expect(archive.version).toBe(13);
  const restored = database();
  restored.product.import(archive);
  expect(restored.source(s.id).text).toBe('Edited');
  expect(restored.sourceOriginal(s.id).text).toBe(s.text);
  const fork = forkChat(store, s.chatId, { fromRevision: s.id, idempotencyKey: randomUUID() });
  const copied = store.source(fork.headRevision!);
  expect(copied.text).toBe('Edited');
  expect(store.sourceOriginal(copied.id).text).toBe(s.text);
  expect(store.detail(fork.id).jobs.find((j) => j.kind === 'translation')?.result?.manual).toBe(
    true
  );
  store.editSource(copied.id, { text: 'Fork only', expectedRevision: 1 });
  expect(store.source(s.id).text).toBe('Edited');
});
test('v2 archive rejects and invalid edit history rolls back', () => {
  const store = database();
  const s = source(store);
  const legacy: any = store.product.export();
  legacy.version = 2;
  delete legacy.tables.source_edits;
  expect(() => database().product.import(legacy)).toThrow('Unsupported archive');
  store.editSource(s.id, { text: 'edited', expectedRevision: 0 });
  const bad: any = store.product.export();
  bad.tables.source_edits[0].revision = 3;
  const target = database();
  expect(() => target.product.import(bad)).toThrow();
  expect(target.chats()).toHaveLength(0);
});
test('valid generated translation caches with zero further attempts; corruption repairs same slot', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live forbidden'));
  const store = database();
  const s = source(store);
  const job = store.requestTranslation(s.id);
  await runAuxiliaryJob(
    auxiliaryBridge(store, new Controls(), new AbortController().signal),
    job.id,
    'test-owner',
    {
      signal: new AbortController().signal,
      approvedOrigins: [],
      authorize: (c) => c,
      onAttemptStart: () => {
        throw new Error('Live forbidden');
      },
      onAttemptFinish: () => {},
    }
  );
  expect(store.job(job.id).status).toBe('completed');
  expect(store.requestTranslation(s.id).status).toBe('completed');
  const count = store.product.attempts(s.chatId).length;
  expect(store.product.attempts(s.chatId)).toHaveLength(count);
  store.db
    .prepare("UPDATE job_results SET result=json_set(result,'$.text','corrupt') WHERE job_id=?")
    .run(job.id);
  expect(store.detail(s.chatId).jobs.some((j) => j.id === job.id)).toBe(false);
  const repaired = store.requestTranslation(s.id);
  expect(repaired.id).toBe(job.id);
  expect(repaired.status).toBe('queued');
  expect(repaired.result).toBeNull();
});
test('edited source exposes hidden slot CAS and rejects a stale translation editor hash', () => {
  const store = database();
  const s = source(store);
  const old = store.editTranslation(s.id, {
    text: 'Before',
    expectedRevision: 0,
    expectedSourceHash: s.hash,
  });
  const edited = store.editSource(s.id, { text: 'After', expectedRevision: 0 });
  expect(edited.translationRevision).toBe(old.revision);
  expect(() =>
    store.editTranslation(s.id, {
      text: 'Stale',
      expectedRevision: old.revision!,
      expectedSourceHash: s.hash,
    })
  ).toThrow('conflict');
  const saved = store.editTranslation(s.id, {
    text: 'Current',
    expectedRevision: edited.translationRevision!,
    expectedSourceHash: edited.hash,
  });
  expect(saved.id).toBe(old.id);
  expect(store.requestTranslation(s.id).result?.text).toBe('Current');
});
test('legacy M0 translation remains cached and malformed manual archives are rejected', () => {
  const store = database();
  const s = source(store);
  const job = store.requestTranslation(s.id);
  const active = store.claimJob(job.id, 'legacy', {})!;
  store.completeJob(job.id, active.generation, 'legacy', {
    mock: true,
    sourceRevision: s.id,
    sourceHash: s.hash,
    text: 'Legacy text',
  });
  expect(store.requestTranslation(s.id).status).toBe('completed');
  const manual = store.editTranslation(s.id, {
    text: 'Manual',
    expectedRevision: job.revision!,
    expectedSourceHash: s.hash,
  });
  const archive: any = store.product.export();
  const row = archive.tables.job_results.find((r: any) => r.job_id === manual.id);
  const result = JSON.parse(row.result);
  result.segments[0].anchors.reverse();
  row.result = JSON.stringify(result);
  expect(() => database().product.import(archive)).toThrow();
});

test('unsupported v2 database refuses startup without rewriting translation reservations', () => {
  const store = database();
  const s = source(store);
  const job = store.requestTranslation(s.id);
  const item = owned.find((item) => item.store === store)!;
  store.close();
  item.store = undefined;
  const path = join(item.dir, 'test.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=2;');
  db.close();
  expect(() => new Store(path)).toThrow('Unsupported database schema version 2');
  const original = new DatabaseSync(path, { readOnly: true });
  try {
    expect(original.prepare('SELECT status FROM jobs WHERE id=?').get(job.id)).toEqual({
      status: 'queued',
    });
    expect(original.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
  } finally {
    original.close();
  }
});
