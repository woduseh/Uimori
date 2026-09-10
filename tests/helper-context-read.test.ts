import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../server/store.js';
import { readHelperChatContext } from '../server/helper-context.js';
import { helperWritingSnapshot } from '../server/helper-runtime.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import {
  contextSourceRefs,
  measureMainContext,
  withContextProjection,
} from '../server/context-planning.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { store: Store; directory: string }[] = [];
const largeChars = 32768;
const benchmark = process.env.NR_CONTEXT_READ_BENCHMARK === '1';
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-context-read-'))
      throw new Error('Unsafe context read cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-context-read-')),
    store = new Store(join(directory, 'synthetic.sqlite'));
  owned.push({ store, directory });
  const connection = store.product.connection({
    title: 'Unused synthetic context connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic context read model',
    connectionId: connection.id,
    modelId: 'fixture-context-read',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const workspace = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: workspace.revision,
    routes: { ...workspace.routes, main: { id: model.id } },
    translationPolicy: workspace.translationPolicy,
  });
  const chat = createFixtureChat(store, 'Synthetic context read history'),
    branch = store.product.branch(chat.id);
  for (let index = 0; index < 4; index++) {
    const current = store.chat(chat.id),
      request = `Synthetic request ${index}`;
    const run = store.createRun(
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
        resources: [],
      })
    ).run;
    store.startRun(run.id);
    store.completeRun(
      run.id,
      `Synthetic source ${index}. The promise remains unresolved.`,
      { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      run.snapshot.settings
    );
  }
  const snapshot = helperWritingSnapshot(store, chat.id, branch.id, 'context');
  const saved = store.context.edit(
    chat.id,
    {
      branchId: branch.id,
      expectedRevision: 0,
      expectedHeadRevision: snapshot.parentRevision,
      idempotencyKey: 'active-summary',
      summary: 'The current summary retains the unresolved promise and its source.',
    },
    snapshot
  );
  let historyCount = 0,
    jobCount = 0;
  const read = () => readHelperChatContext(store, chat.id, branch.id);
  // Populate complete validated candidates and cancelled jobs outside all measured regions.
  // They never activate, so the current model-visible state remains identical as history grows.
  function addHistory(count: number, jobs: number) {
    const current = helperWritingSnapshot(store, chat.id, branch.id, 'context');
    store.transaction(() => {
      while (historyCount < count) {
        const summary = `Historical candidate ${historyCount}. `.padEnd(largeChars, 'x');
        const candidate = withContextProjection(
          current,
          contextSourceRefs(current).slice(0, 2),
          summary
        );
        const measured = measureMainContext(candidate);
        store.context.publishPrepared(
          {
            ...candidate,
            contextPlan: {
              ...candidate.contextPlan!,
              estimatedInputTokens: measured.estimatedInputTokens,
            },
          },
          { origin: 'manual', activate: false }
        );
        historyCount++;
      }
      while (jobCount < jobs) {
        const job = store.context.schedule(
          chat.id,
          {
            branchId: branch.id,
            expectedRevision: saved.activeRevision,
            expectedHeadRevision: current.parentRevision,
            idempotencyKey: `historical-job-${jobCount}`,
          },
          { ...current, request: `Historical job ${jobCount}. `.padEnd(largeChars, 'y') }
        );
        store.context.cancel(chat.id, job.id);
        jobCount++;
      }
    });
  }
  return { store, chatId: chat.id, branchId: branch.id, saved, read, addHistory };
}

function decodedRead(store: Store, read: () => ReturnType<typeof readHelperChatContext>) {
  const checkpoint = store.context.checkpoint.bind(store.context),
    job = store.context.job.bind(store.context);
  const decoded = { checkpointPlans: 0, jobSnapshots: 0, jsonBytes: 0 };
  const checkpointSpy = vi.spyOn(store.context, 'checkpoint').mockImplementation((ref) => {
    const value = checkpoint(ref);
    decoded.checkpointPlans++;
    decoded.jsonBytes += Buffer.byteLength(JSON.stringify(value.plan));
    return value;
  });
  const jobSpy = vi.spyOn(store.context, 'job').mockImplementation((id) => {
    const value = job(id);
    decoded.jobSnapshots++;
    decoded.jsonBytes += Buffer.byteLength(JSON.stringify(value.snapshot));
    return value;
  });
  try {
    return { result: read(), decoded };
  } finally {
    checkpointSpy.mockRestore();
    jobSpy.mockRestore();
  }
}

/** Reproduce the previous detail-then-project path using the same DB, validators and projection. */
function legacyRead<T>(store: Store, action: () => T): T {
  const current = store.context.current;
  store.context.current = (chatId, branchId) => store.context.detail(chatId, branchId);
  try {
    return action();
  } finally {
    store.context.current = current;
  }
}

function measureReads(f: ReturnType<typeof fixture>, before: unknown, after: unknown) {
  const warmupRounds = 3,
    sampleCount = 9,
    readsPerSample = 10;
  const samples = { before: [] as number[], after: [] as number[] };
  const sample = () => {
    const started = performance.now();
    for (let index = 0; index < readsPerSample; index++) f.read();
    return (performance.now() - started) / readsPerSample;
  };
  for (let index = 0; index < warmupRounds + sampleCount; index++) {
    const oldFirst = index % 2 === 0;
    let old: number, current: number;
    if (oldFirst) {
      old = legacyRead(f.store, sample);
      current = sample();
    } else {
      current = sample();
      old = legacyRead(f.store, sample);
    }
    if (index >= warmupRounds) {
      samples.before.push(old);
      samples.after.push(current);
    }
  }
  const summarize = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: sorted[Math.floor(sorted.length / 2)], samplesMs: values };
  };
  const directory = resolve(
    'output',
    'benchmarks',
    `context-read-${new Date().toISOString().replaceAll(':', '-')}`
  );
  mkdirSync(directory, { recursive: true });
  const measured = {
    schema: 1,
    kind: 'helper-active-context-read',
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      os: release(),
      cpu: cpus()[0]?.model,
    },
    fixture: {
      activeCheckpoints: 1,
      historicalCandidates: 100,
      cancelledJobs: 50,
      historicalTextChars: largeChars,
      sources: 4,
    },
    method: {
      warmupRounds,
      sampleCount,
      readsPerSample,
      order: 'alternating before/after, same initialized SQLite DB',
      before: 'UI detail read followed by the unchanged helper projection',
      after: 'active-only read followed by the unchanged helper projection',
      timing: 'synchronous full helper read, without JSON instrumentation or output serialization',
      bytes:
        'separate call counts UTF-8 JSON bytes of decoded checkpoint plans and job snapshots; excludes source/profile reads and raw database row bytes',
    },
    before: { timing: summarize(samples.before), decoded: before },
    after: { timing: summarize(samples.after), decoded: after },
    modelResultJsonBytes: Buffer.byteLength(JSON.stringify(f.read())),
    sourceHashes: Object.fromEntries(
      [
        'server/context-store.ts',
        'server/helper-context.ts',
        'tests/helper-context-read.test.ts',
      ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])
    ),
    limitations: [
      'Synthetic local SQLite fixture; no provider calls.',
      'Warm-cache measurements are diagnostic and are not a timing test gate.',
    ],
  };
  writeFileSync(join(directory, 'context-read.json'), `${JSON.stringify(measured, null, 2)}\n`);
  console.log(`Context read measurements: ${join(directory, 'context-read.json')}`);
}

test('helper reads decode one active checkpoint as large history grows while UI detail retains history and jobs', () => {
  const f = fixture(),
    baseline = decodedRead(f.store, f.read);
  expect(baseline.result.usable).toBe(true);
  expect(baseline.decoded).toMatchObject({ checkpointPlans: 1, jobSnapshots: 0 });
  for (const [candidates, jobs] of [
    [10, 5],
    [100, 50],
  ]) {
    f.addHistory(candidates!, jobs!);
    const current = decodedRead(f.store, f.read);
    expect(current).toEqual(baseline);
  }
  const { checkpoints, jobs, ...metadata } = f.store.context.detail(f.chatId, f.branchId);
  expect(checkpoints).toHaveLength(100);
  expect(jobs).toHaveLength(50);
  expect(f.store.context.current(f.chatId, f.branchId)).toEqual(metadata);
  const old = legacyRead(f.store, () => decodedRead(f.store, f.read));
  expect(old.result).toEqual(baseline.result);
  expect(old.decoded).toMatchObject({ checkpointPlans: 101, jobSnapshots: 50 });
  expect(old.decoded.jsonBytes).toBeGreaterThan(largeChars * 150);
  if (benchmark) measureReads(f, old.decoded, baseline.decoded);
});

test('active-only reads recheck current notes and preserve active checkpoint hash validation', () => {
  const f = fixture(),
    before = f.read();
  f.store.story.notes.write(f.chatId, {
    branchId: f.branchId,
    expectedRevision: before.notesRevision,
    expectedHeadRevision: before.headRevision,
    idempotencyKey: 'new-correction',
    author: 'Synthetic user',
    text: 'The old derived promise was corrected by the user.',
  });
  const after = f.read(),
    {
      checkpoints: _checkpoints,
      jobs: _jobs,
      ...metadata
    } = f.store.context.detail(f.chatId, f.branchId);
  expect(after.checkpoint).toEqual(before.checkpoint);
  expect(after).toMatchObject({
    activeRevision: before.activeRevision,
    notesRevision: before.notesRevision + 1,
    usable: false,
  });
  expect(after.invalidReason).toBeTruthy();
  expect(after.notes).toHaveLength(1);
  expect(f.store.context.current(f.chatId, f.branchId)).toEqual(metadata);
  f.store.db
    .prepare("UPDATE context_checkpoints SET plan=json_set(plan,'$.summary',?) WHERE id=?")
    .run('Corrupted active summary', before.checkpoint!.id);
  expect(f.read).toThrow('CONTEXT_CHECKPOINT_HASH_MISMATCH');
});
