import { createSyntheticBot, syntheticStoryScenes } from './synthetic-story.mjs';
import { importChatTranscript } from '../dist/server/chat-transcript.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../dist/server/store.js';
import { previousContextPlan } from '../dist/server/context-planning.js';
import { captureLogicalHistory } from '../dist/server/prompt-snapshot.js';
import { nativeSourceSnapshot } from '../dist/server/risu-native-actions.js';
import { assertBuild, root } from './lib.mjs';

// Real file SQLite, synthetic complete ancestry, no provider or user database.
// Reuse the printed --fixture directory for paired measurements on identical rows.
const args = process.argv.slice(2);
const longStory = args.includes('--long-story');
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
// Property ordering is not part of snapshot semantics; array/message ordering is.
const outputHash = (value) =>
  hash(
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]])
          )
        : item
    )
  );
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
let fixture;
if (args.includes('--fixture')) {
  fixture = JSON.parse(await readFile(descriptor, 'utf8'));
  assert.equal(fixture.kind, 'uimori-context-storage-synthetic-v2');
  if (longStory) assert.equal(fixture.mode, 'long-story');
}
const store = new Store(path.join(directory, 'synthetic.sqlite'));
try {
  if (!fixture) {
    const counts = longStory ? [10, 30, 100] : [10, 100, 300];
    const bot = createSyntheticBot(store, { loreCount: longStory ? 50 : 0 });
    fixture = {
      kind: 'uimori-context-storage-synthetic-v2',
      mode: longStory ? 'long-story' : 'legacy-8000chars',
      corpus: {
        language: longStory ? 'ko' : 'en',
        tokenizer: 'o200k_base',
        targetTokensPerSource: longStory ? 7500 : null,
        counts,
        loreCount: bot.package.lore.length,
        loreCharsPerEntry: longStory ? 300 : 0,
        // No binaries or invented stored asset references are needed for these paths.
        nativeAssetCount: bot.package.nativeRisu.assets.length,
        storedAssetCount: 0,
      },
      scenarios: [],
    };
    for (const count of counts) {
      const scenes = syntheticStoryScenes(count, { longStory });
      const imported = importChatTranscript(store, {
        idempotencyKey: 'measurement-' + count,
        transcript: {
          format: 'uimori-chat-transcript',
          version: 2,
          exportedAt: new Date().toISOString(),
          title: 'Synthetic ' + count,
          packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
          notes: [],
          entries: scenes.map(({ metrics: _metrics, ...entry }) => entry),
        },
      });
      const chat = imported.chat,
        history = store.history(chat.headRevision);
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
      fixture.scenarios.push({
        count,
        charsPerSource: longStory ? null : 8000,
        sources: scenes.map(({ metrics }, index) => ({
          revision: history[index].revision,
          ...metrics,
        })),
        chatId: chat.id,
        head: chat.headRevision,
        expectedHistoryHash: hash(JSON.stringify(history)),
        settings: chat.settings,
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
    mode: fixture.mode ?? 'legacy-8000chars',
    corpus: fixture.corpus ?? {
      language: 'en',
      counts: fixture.scenarios.map((scenario) => scenario.count),
    },
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
      fixture.mode === 'long-story'
        ? 'Synthetic Korean scenes around 7500 o200k_base tokens each, 10/30/100 scenes, 50 synthetic lore entries and no assets; exact source metrics are recorded.'
        : 'Synthetic 8000-character English scenes imported through the current transcript format with settled run snapshots.',
      'Logical-history capture and native source snapshot are synchronous storage/projection stages. No CBS/regex/Lua worker, provider, browser, or complete next-generation timing is included.',
      'Reused fixtures retain full semantic output hashes for all new paths. Hashing, token counting and preservation assertions are outside timings.',
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
    const chat = store.chat(scenario.chatId);
    const snapshot = {
      chatId: scenario.chatId,
      parentRevision: scenario.head,
      request: 'Synthetic next-scene preparation measurement.',
      settingsRevision: chat.settingsRevision,
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
      captureLogicalHistory: () => captureLogicalHistory(store, snapshot),
      nativeSourceSnapshot: () => nativeSourceSnapshot(store, scenario.chatId, scenario.head),
    };
    // Save these once so paired before/after runs validate the same full result, not
    // a new expected value recomputed from the changed implementation.
    scenario.expectedPathHashes ??= {};
    for (const name of ['captureLogicalHistory', 'nativeSourceSnapshot']) {
      if (!scenario.expectedPathHashes[name]) {
        scenario.expectedPathHashes[name] = outputHash(paths[name]());
        await save(descriptor, fixture);
      }
    }
    const results = {};
    for (const [name, action] of Object.entries(paths)) {
      const check = (value) => {
        if (name === 'previousCheckpoint') assert.equal(value, undefined);
        else if (name === 'captureLogicalHistory' || name === 'nativeSourceSnapshot') {
          assert.equal(outputHash(value), scenario.expectedPathHashes[name]);
          const logical = name === 'captureLogicalHistory' ? value : value.snapshot.logicalHistory;
          assert.deepEqual(
            logical
              .filter((message) => message.role === 'assistant')
              .map((message) => message.text),
            history.map((source) => source.text)
          );
          assert.equal(logical.length, scenario.count * 2);
          if (name === 'nativeSourceSnapshot') {
            assert.equal(value.source.id, scenario.head);
            assert.equal(value.source.text, history.at(-1).text);
            assert.equal(outputHash(logical), scenario.expectedPathHashes.captureLogicalHistory);
          }
        } else {
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
        ...(scenario.expectedPathHashes[name]
          ? { outputHash: scenario.expectedPathHashes[name] }
          : {}),
      };
    }
    report.scenarios.push({
      count: scenario.count,
      charsPerSource: scenario.charsPerSource,
      sources: scenario.sources ?? null,
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
