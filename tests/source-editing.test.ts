import { DATABASE_SCHEMA_VERSION } from '../server/database-schema.js';
import { readStoredRunSnapshot } from '../server/run-projections.js';
import { rejudgeTranslation } from '../server/source-editing.js';
import { createFixtureChat } from './fixtures/chat.js';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
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

function promptSetting(store: Store, title: string, maxRetries = 1) {
  const workspace = promptWorkspace(store);
  return updatePromptWorkspace(store, {
    expectedRevision: workspace.revision,
    translation: { title, program: createDefaultRisuPrompt(title, 'translation'), values: {} },
    translationPolicy: { ...workspace.translationPolicy, maxRetries },
  });
}

async function translateFixture(store: Store, jobId: string) {
  await runAuxiliaryJob(
    auxiliaryBridge(store, new Controls(), new AbortController().signal),
    jobId,
    'whole-source-owner',
    {
      signal: new AbortController().signal,

      authorize: (c) => c,
      onAttemptStart: () => {
        throw new Error('Live forbidden');
      },
      onAttemptFinish: () => {},
    }
  );
  expect(store.job(jobId).status).toBe('completed');
}

test('new translation freezes the current prompt and retry policy while pending work keeps its reservation', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Live forbidden'));
  const store = database();
  const chat = createFixtureChat(store, 'current translation');
  const original = source(store, chat.id, 'A'.repeat(60000));
  const originalSnapshot = readStoredRunSnapshot(store, original.runId);
  const firstSettings = promptSetting(store, 'First translation instructions');
  const reserved = store.requestTranslation(original.id);
  expect(reserved.input).toMatchObject({
    promptWorkspaceRevision: firstSettings.revision,
    translationPrompt: { title: 'First translation instructions' },
    translationPolicy: { maxRetries: 1, maxCalls: 16 },
  });
  const nextSettings = promptSetting(store, 'Next instructions', 0);
  expect(store.requestTranslation(original.id).input).toEqual(reserved.input);
  await translateFixture(store, reserved.id);
  expect(store.job(reserved.id).result?.text).toBe(original.text);
  const next = store.retranslate(original.id);
  expect(next.id).not.toBe(reserved.id);
  expect(next.input).toMatchObject({
    promptWorkspaceRevision: nextSettings.revision,
    translationPrompt: { title: 'Next instructions' },
    translationPolicy: { maxRetries: 0 },
  });
  expect(next.previousResult).toMatchObject({
    jobId: reserved.id,
    result: { text: original.text },
  });
  await translateFixture(store, next.id);
  expect(store.job(reserved.id).result?.text).toBe(original.text);
  expect(store.job(next.id).previousResult).toBeUndefined();
  expect(readStoredRunSnapshot(store, original.runId)).toEqual(originalSnapshot);
  expect(
    store.db.prepare("SELECT name FROM sqlite_master WHERE name='job_chunks'").get()
  ).toBeUndefined();
});

test('explicit retry creates a new current-policy job and preserves failed candidate plus last successful translation', async () => {
  const store = database();
  const original = source(store);
  const successful = store.editTranslation(original.id, {
    text: 'Previous successful translation',
    expectedRevision: 0,
    expectedSourceHash: original.hash,
  });
  const job = store.retranslate(original.id);
  const active = store.claimJob(job.id, 'failed-owner', {})!;
  store.finishAuxiliary(job.id, active.generation, 'failed-owner', {
    status: 'failed',
    result: {
      mock: true,
      sourceRevision: original.id,
      sourceHash: original.hash,
      text: 'Uncertain candidate',
    },
    error: 'TRANSLATION_REFUSAL_UNCERTAIN',
  });
  const prior = store.job(job.id);
  expect(prior.previousResult).toMatchObject({
    jobId: successful.id,
    result: { text: 'Previous successful translation' },
  });
  const settings = promptSetting(store, 'Retry current instructions', 0);
  const count = store.db.prepare('SELECT count(*) AS n FROM jobs').get();
  expect(() =>
    store.retryJob(job.id, () => {
      throw new Error('Invalid current model');
    })
  ).toThrow('Invalid current model');
  expect(store.db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual(count);
  expect(store.job(job.id)).toEqual(prior);
  const retried = store.retryJob(job.id);
  expect(retried.id).not.toBe(job.id);
  expect(retried.revision).toBe(prior.revision! + 1);
  expect(retried.input).toMatchObject({
    promptWorkspaceRevision: settings.revision,
    translationPolicy: { maxRetries: 0 },
  });
  expect(retried.previousResult).toMatchObject({ jobId: successful.id });
  expect(store.retryJob(job.id)).toEqual(retried);
  expect(store.job(job.id).result?.text).toBe('Uncertain candidate');
  await translateFixture(store, retried.id);
  expect(store.job(job.id).result?.text).toBe('Uncertain candidate');
});

test('failure diagnostics persist only for the current owner and generation without changing frozen inputs', () => {
  const store = database();
  const original = source(store);
  const originalSnapshot = structuredClone(readStoredRunSnapshot(store, original.runId));
  promptSetting(store, 'Frozen translation instructions');
  const job = store.requestTranslation(original.id);
  const active = store.claimJob(job.id, 'diagnostic-owner', {})!;
  const reservedSource = structuredClone(store.source(original.id));
  const frozenInput = structuredClone(store.job(job.id).input);
  if (!frozenInput || typeof frozenInput !== 'object' || Array.isArray(frozenInput))
    throw new Error('Expected a frozen translation input object');
  const failure = {
    status: 'failed',
    result: {
      mock: true,
      sourceRevision: original.id,
      sourceHash: original.hash,
      text: 'Uncertain candidate',
    },
    error: 'TRANSLATION_REFUSAL_UNCERTAIN',
    diagnostic: {
      stage: 'translation-refusal' as const,
      code: 'TRANSLATION_REFUSAL_UNCERTAIN',
      attemptId: 'classifier-attempt',
    },
  };
  for (const [generation, owner] of [
    [active.generation + 1, 'diagnostic-owner'],
    [active.generation, 'stale-owner'],
  ] as const) {
    expect(store.finishAuxiliary(job.id, generation, owner, failure)).toBe(false);
    expect(store.job(job.id).input).toEqual(frozenInput);
    expect(store.job(job.id).status).toBe('running');
    expect(store.job(job.id).result).toBeNull();
  }
  expect(store.finishAuxiliary(job.id, active.generation, 'diagnostic-owner', failure)).toBe(true);
  expect(store.job(job.id).input).toEqual({
    ...frozenInput,
    failureDiagnostic: failure.diagnostic,
  });
  expect(store.job(job.id).result).toEqual(failure.result);
  expect(store.source(original.id)).toEqual(reservedSource);
  expect(reservedSource.text).toBe(original.text);
  expect(reservedSource.hash).toBe(original.hash);
  expect(readStoredRunSnapshot(store, original.runId)).toEqual(originalSnapshot);
  const completed = structuredClone(store.job(job.id));
  expect(
    store.finishAuxiliary(job.id, active.generation, 'diagnostic-owner', {
      ...failure,
      diagnostic: { ...failure.diagnostic, attemptId: 'late-attempt' },
    })
  ).toBe(false);
  expect(store.job(job.id)).toEqual(completed);
});

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
test('CAS manual edit fences a late owned job while preserving prior execution evidence', () => {
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
  expect(
    store.finishAuxiliary(job.id, active.generation, 'owner', {
      status: 'completed',
      result: { text: 'late' },
      error: null,
    })
  ).toBe(false);
  expect(manual.id).not.toBe(job.id);
  expect(store.job(job.id).generation).toBeGreaterThan(active.generation);
  expect(() =>
    store.editTranslation(s.id, {
      text: 'conflict',
      expectedRevision: job.revision!,
      expectedSourceHash: s.hash,
    })
  ).toThrow('conflict');
  const forced = store.retranslate(s.id);
  expect(forced.id).not.toBe(job.id);
  expect(forced.previousResult).toMatchObject({ jobId: manual.id, result: { text: 'Manual' } });
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
  expect(
    store.finishAuxiliary(job.id, active.generation, 'owner', {
      status: 'completed',
      result: {},
      error: null,
    })
  ).toBe(false);
  expect(store.job(job.id).status).toBe('stale');
  expect(store.detail(s.chatId).jobs.some((j) => j.id === job.id)).toBe(false);
  expect(() => store.editSource(s.id, { text: 'bad', expectedRevision: 0 })).toThrow('conflict');
  expect(store.editSource(s.id, { text: edited.text, expectedRevision: 1 }).editRevision).toBe(1);
  expect(store.requestTranslation(s.id).sourceHash).toBe(edited.hash);
});

test('valid generated translation caches with zero further attempts; identity corruption creates a clean reservation', async () => {
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

      authorize: (c) => c,
      onAttemptStart: () => {
        throw new Error('Live forbidden');
      },
      onAttemptFinish: () => {},
    }
  );
  expect(store.job(job.id).status).toBe('completed');
  const count = store.product.attempts(s.chatId).length;
  expect(store.requestTranslation(s.id)).toMatchObject({ id: job.id, status: 'completed' });
  expect(store.product.attempts(s.chatId)).toHaveLength(count);
  store.db
    .prepare(
      "UPDATE job_results SET result=json_set(result,'$.sourceHash','corrupt') WHERE job_id=?"
    )
    .run(job.id);
  expect(store.detail(s.chatId).jobs.some((j) => j.id === job.id)).toBe(false);
  const repaired = store.requestTranslation(s.id);
  expect(repaired.id).not.toBe(job.id);
  expect(repaired.previousResult).toBeUndefined();
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
  expect(saved.id).not.toBe(old.id);
  expect(store.requestTranslation(s.id).result?.text).toBe('Current');
});
test('unsupported future database refuses startup without rewriting translation reservations', () => {
  const store = database();
  const s = source(store);
  const job = store.requestTranslation(s.id);
  const item = owned.find((item) => item.store === store)!;
  store.close();
  item.store = undefined;
  const path = join(item.dir, 'test.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA user_version=${DATABASE_SCHEMA_VERSION + 1};`);
  db.close();
  expect(() => new Store(path)).toThrow(
    `Database version ${DATABASE_SCHEMA_VERSION + 1} is not the personal-v1 format`
  );
  const original = new DatabaseSync(path, { readOnly: true });
  try {
    expect(original.prepare('SELECT status FROM jobs WHERE id=?').get(job.id)).toEqual({
      status: 'queued',
    });
    expect(original.prepare('PRAGMA user_version').get()).toEqual({
      user_version: DATABASE_SCHEMA_VERSION + 1,
    });
  } finally {
    original.close();
  }
});

function failedJudgment(store: Store) {
  const original = source(store);
  const successful = store.editTranslation(original.id, {
    text: 'Previous successful translation',
    expectedRevision: 0,
    expectedSourceHash: original.hash,
  });
  const job = store.retranslate(original.id);
  const active = store.claimJob(job.id, 'owner', {})!;
  store.finishAuxiliary(job.id, active.generation, 'owner', {
    status: 'failed',
    error: 'TRANSLATION_REFUSAL_CHECK_FAILED',
    result: {
      mock: false,
      sourceRevision: original.id,
      sourceHash: original.hash,
      text: 'Saved translation 😀\r\n',
    },
  });
  return { original, successful, job: store.job(job.id) };
}

test.each(['source edit', 'newer translation', 'refusal', 'no candidate'])(
  'rejects judgment recovery after %s',
  (reason) => {
    const store = database();
    const { original, job } = failedJudgment(store);
    if (reason === 'source edit')
      store.editSource(original.id, { text: 'Changed', expectedRevision: 0 });
    if (reason === 'newer translation') store.retranslate(original.id);
    if (reason === 'refusal')
      store.db
        .prepare('UPDATE jobs SET error=? WHERE id=?')
        .run('TRANSLATION_REFUSAL_RETRIES_EXHAUSTED', job.id);
    if (reason === 'no candidate')
      store.db.prepare('DELETE FROM job_results WHERE job_id=?').run(job.id);
    expect(() => rejudgeTranslation(store, job.id)).toThrow('recovery unavailable');
  }
);
