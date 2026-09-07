import { createFixtureChat } from './fixtures/chat.js';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
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
function source(store: Store, chatId = createFixtureChat(store, 'editing').id) {
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
      'Original paragraph.\n\nSecond paragraph.',
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings
    ).id
  );
}
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
  expect(archive.version).toBe(10);
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
