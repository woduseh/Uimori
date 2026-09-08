import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../dist/server/store.js';
import { previousContextPlan } from '../dist/server/context-planning.js';
import { assertBuild, root } from './lib.mjs';

// Real file SQLite, synthetic complete ancestry, no provider or user database.
// Reuse the printed --fixture directory for paired measurements on identical rows.
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const label = args.includes('--label') ? option('--label') : 'measurement';
if (!/^[a-z0-9-]+$/iu.test(label)) throw new Error('Invalid label');
if (!global.gc) throw new Error('Run node --expose-gc scripts/measure-context-storage.mjs');
const build = await assertBuild();
const base = path.join(root, 'output', 'context-storage');
await mkdir(base, { recursive: true });
const directory = args.includes('--fixture')
  ? path.resolve(option('--fixture'))
  : await mkdtemp(path.join(base, 'fixture-'));
const within = path.relative(base, directory);
if (path.isAbsolute(within) || within.startsWith('..') || !within.startsWith('fixture-'))
  throw new Error('Only owned output/context-storage/fixture-* directories are accepted');
const descriptor = path.join(directory, 'fixture.json');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
let fixture;
if (args.includes('--fixture')) {
  fixture = JSON.parse(await readFile(descriptor, 'utf8'));
  assert.equal(fixture.kind, 'uimori-context-storage-synthetic-v1');
}
const store = new Store(path.join(directory, 'synthetic.sqlite'));
try {
  if (!fixture) {
    const bot = store.product.content({
      kind: 'bot',
      title: 'Synthetic performance bot',
      description: '',
      text: '',
      loading: 'pinned',
      relatedIds: [],
      package: {
        version: 1,
        id: 'benchmark',
        revision: 1,
        title: 'Synthetic performance bot',
        description: '',
        body: '',
        lore: [],
        instructions: [],
        controls: [],
        transforms: [],
      },
    });
    fixture = { kind: 'uimori-context-storage-synthetic-v1', scenarios: [] };
    const insertRun = store.db.prepare(`INSERT INTO runs
      (id,chat_id,parent_revision,status,request,snapshot,request_key,command,source_revision,created_at,updated_at,branch_id)
      VALUES(?,?,?,'completed',?,?,?,?,?,?,?,?)`);
    const insertSource = store.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)');
    for (const count of [10, 100, 300]) {
      const chat = store.createChat(`Synthetic ${count} scenes`, 'calm', { botId: bot.id });
      const history = [];
      const paragraphs =
        'A traveler records the river, the bridge and the lantern. This is synthetic prose for a local measurement.\n\n';
      const settings = { ...chat.settings, translation: false, maxCalls: 8 };
      const plan = {
        version: 1,
        status: 'ready',
        budget: { inputTokenLimit: 272000, estimator: 'o200k_base-v1' },
        dependencyKey: 'synthetic-stable-canon',
        estimatedInputTokens: 1000,
        compacted: [],
        recentSourceRevisions: [],
        summary: null,
        summaryCalls: 0,
        usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
        error: null,
      };
      store.transaction(() => {
        for (let index = 0; index < count; index++) {
          const id = `source-${count}-${index}`;
          const runId = `run-${count}-${index}`;
          const text = (`Scene ${index}.\n\n` + paragraphs.repeat(80)).slice(0, 8000);
          const parentRevision = history.at(-1)?.revision ?? null;
          const time = new Date(index * 1000).toISOString();
          const snapshot = {
            chatId: chat.id,
            request: `Continue scene ${index}`,
            parentRevision,
            settingsRevision: 1,
            settings,
            history,
            resources: [],
            branchId: `main:${chat.id}`,
            contextPlan: {
              ...plan,
              recentSourceRevisions: history.map((source) => source.revision),
            },
          };
          insertRun.run(
            runId,
            chat.id,
            parentRevision,
            snapshot.request,
            JSON.stringify(snapshot),
            runId,
            '{}',
            id,
            time,
            time,
            `main:${chat.id}`
          );
          insertSource.run(id, chat.id, runId, parentRevision, text, hash(text), time);
          history.push({ revision: id, text });
        }
        store.db
          .prepare('UPDATE chats SET head_revision=? WHERE id=?')
          .run(history.at(-1).revision, chat.id);
        store.db
          .prepare('UPDATE branches SET head_revision=?,revision=? WHERE chat_id=?')
          .run(history.at(-1).revision, count + 1, chat.id);
      });
      fixture.scenarios.push({
        count,
        charsPerSource: 8000,
        chatId: chat.id,
        head: history.at(-1).revision,
        expectedHistoryHash: hash(JSON.stringify(history)),
        settings,
        plan,
      });
    }
    await save(descriptor, fixture);
  }
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const digest = createHash('sha256');
  for (const row of store.db.prepare('SELECT id,snapshot FROM runs ORDER BY id').iterate()) {
    digest.update(row.id);
    digest.update(row.snapshot);
  }
  const report = {
    label,
    startedAt: new Date().toISOString(),
    fixture: directory,
    fixtureSnapshotHash: digest.digest('hex'),
    build: { sourceHash: build.sourceHash, distHash: build.distHash },
    environment: {
      node: process.version,
      sqlite: process.versions.sqlite,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    warmups: 3,
    repetitions: 9,
    scenarios: [],
    limitations: [
      'Storage stages called by generation, not end-to-end model latency or billing.',
      'Synthetic 8000-character scenes with full cumulative run history; no profile/resource/diagnostic payloads.',
      'First timed sample precedes per-path warmups, but fixture validation/hash/history reads have already warmed caches. OS file cache is not flushed.',
      'Explicit GC before each sample is outside timing. Heap delta is retained-at-return allocation, not peak RSS.',
      'SQL instrumentation is a separate untimed diagnostic invocation; timings have no instrumentation.',
      'Ready plans have no compacted sources: exercises full checkpoint miss. Reuse/invalidation verified by tests.',
    ],
  };
  const summary = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)],
      min: sorted[0],
      max: sorted.at(-1),
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      samples: values,
    };
  };
  for (const scenario of fixture.scenarios) {
    const history = store.history(scenario.head);
    assert.equal(hash(JSON.stringify(history)), scenario.expectedHistoryHash);
    const snapshot = {
      chatId: scenario.chatId,
      history,
      resources: [],
      settings: scenario.settings,
      contextPlan: scenario.plan,
    };
    const paths = {
      history: () => store.history(scenario.head),
      previousCheckpoint: () => previousContextPlan(store, snapshot),
      combined: () => {
        const current = store.history(scenario.head);
        return {
          history: current,
          previous: previousContextPlan(store, { ...snapshot, history: current }),
        };
      },
    };
    const results = {};
    for (const [name, action] of Object.entries(paths)) {
      const check = (value) => {
        if (name === 'previousCheckpoint') assert.equal(value, undefined);
        else {
          assert.equal(
            hash(JSON.stringify(name === 'history' ? value : value.history)),
            scenario.expectedHistoryHash
          );
          if (name === 'combined') assert.equal(value.previous, undefined);
        }
      };
      const sample = () => {
        global.gc();
        const heap = process.memoryUsage().heapUsed;
        const cpu = process.cpuUsage();
        const start = performance.now();
        const value = action();
        const elapsedMs = performance.now() - start;
        const used = process.cpuUsage(cpu);
        const heapDeltaBytes = process.memoryUsage().heapUsed - heap;
        check(value);
        return { elapsedMs, cpuMs: (used.user + used.system) / 1000, heapDeltaBytes };
      };
      const first = sample();
      for (let i = 0; i < 3; i++) check(action());
      const samples = Array.from({ length: 9 }, sample);
      const original = store.db.prepare;
      let queries = 0;
      let returnedStringBytes = 0;
      store.db.prepare = function (sql) {
        const statement = original.call(this, sql);
        for (const method of ['get', 'all']) {
          const execute = statement[method];
          statement[method] = function (...values) {
            queries++;
            const result = execute.apply(this, values);
            for (const row of Array.isArray(result) ? result : [result])
              for (const value of Object.values(row ?? {}))
                if (typeof value === 'string') returnedStringBytes += Buffer.byteLength(value);
            return result;
          };
        }
        return statement;
      };
      try {
        check(action());
      } finally {
        store.db.prepare = original;
      }
      results[name] = {
        first,
        elapsedMs: summary(samples.map((s) => s.elapsedMs)),
        cpuMs: summary(samples.map((s) => s.cpuMs)),
        heapDeltaBytes: summary(samples.map((s) => s.heapDeltaBytes)),
        queries,
        returnedStringBytes,
      };
    }
    report.scenarios.push({
      count: scenario.count,
      charsPerSource: scenario.charsPerSource,
      outputHash: scenario.expectedHistoryHash,
      results,
    });
    console.log(
      JSON.stringify({
        label,
        count: scenario.count,
        paths: Object.fromEntries(
          Object.entries(results).map(([name, result]) => [
            name,
            {
              medianMs: result.elapsedMs.median,
              queries: result.queries,
              returnedStringBytes: result.returnedStringBytes,
            },
          ])
        ),
      })
    );
  }
  report.finishedAt = new Date().toISOString();
  report.status = 'PASS';
  const file = path.join(directory, `${label}-${Date.now()}.json`);
  await save(file, report);
  console.log(JSON.stringify({ report: file, fixture: directory, status: report.status }));
} finally {
  store.close();
}
