import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../dist/server/store.js';
import { importChatTranscript } from '../dist/server/chat-transcript.js';
import { captureLogicalHistory } from '../dist/server/prompt-snapshot.js';
import { buildMainProviderRequest } from '../dist/server/main-request.js';
import { prepareNativeRisuRun } from '../dist/server/risu-native-run.js';
import { disposeAllNativeRisuSessions } from '../dist/server/risu-native-runtime.js';
import { encodeResponses } from '../dist/core/openai-protocol.js';
import { createSyntheticBot, syntheticStoryScenes } from './synthetic-story.mjs';
import { assertBuild, fingerprint, json, root } from './lib.mjs';

// Exact reusable inputs in an owned synthetic DB. No provider, user DB or elapsed-time gate.
const directory = path.resolve(process.argv[2]);
const label = process.argv[3] ?? 'baseline';
assert.match(label, /^[a-z0-9-]+$/u);
assert.ok(globalThis.gc, 'Use node --expose-gc');
const scenarios = [
  { scenes: 10, lore: 50 },
  { scenes: 100, lore: 500 },
];
const marker = path.join(directory, 'fixture.json');
if (!existsSync(directory)) {
  await mkdir(directory, { recursive: true });
  await json(marker, { kind: 'uimori-native-run-benchmark-v2', scenarios });
}
assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
  kind: 'uimori-native-run-benchmark-v2',
  scenarios,
});
const hash = (value) => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const report = {
  startedAt: new Date().toISOString(),
  build: await assertBuild(),
  source: await fingerprint(),
  gitHead: git('rev-parse', 'HEAD').trim(),
  gitStatus: git('status', '--porcelain=v1'),
  runnerHash: hash(await readFile(new URL(import.meta.url))),
  environment: {
    node: process.version,
    sqlite: process.versions.sqlite,
    platform: os.platform(),
    release: os.release(),
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    memory: os.totalmem(),
  },
  method: {
    boundary:
      'prepareNativeRisuRun entry through compilation and serialized Responses body; actual input/editInput/start callback path, no preview',
    excluded:
      'DB reservation/history capture, lore selection/context compaction, network/model wait and browser click; not a full generation measurement',
    first:
      'First invocation in this process; OS caches are not reset, fixtures were read before timing',
    warmups: 2,
    samples: 9,
    resources:
      'Process CPU includes workers; RSS sampled every 5ms and at return, not a guaranteed peak; explicit GC outside timing',
    acceptance:
      '100-scene local preparation median saves >=50ms and >=15%; no material normal-case regression; identical prepared output and wire body; no retained cache/dependency',
  },
  conditions: [],
};
await writeFile(path.join(directory, `${label}.diff`), git('diff', 'HEAD', '--binary'));
// Include untracked measurement source as well as the full tree fingerprint.
await writeFile(
  path.join(directory, `${label}-runner.mjs`),
  await readFile(new URL(import.meta.url))
);
globalThis.fetch = () => {
  throw new Error('External calls forbidden in benchmark');
};
const summary = (samples, key) => {
  const values = samples.map((row) => row[key]).sort((a, b) => a - b);
  return { median: values[4], min: values[0], max: values.at(-1) };
};
// Hash logical rows, including WAL contents. Main-file bytes alone omit uncheckpointed rows.
function databaseHash(store) {
  const digest = createHash('sha256');
  for (const { name } of store.db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all()) {
    const rows = store.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    digest.update(
      name +
        '\0' +
        rows
          .map((row) => JSON.stringify(row))
          .sort()
          .join('\n')
    );
  }
  return digest.digest('hex');
}
for (const scenario of scenarios) {
  const fixtureFile = path.join(directory, `input-${scenario.scenes}.json`);
  const dbFile = path.join(directory, `scenes-${scenario.scenes}.sqlite`);
  const fresh = !existsSync(dbFile);
  const store = new Store(dbFile);
  try {
    if (fresh) {
      const bot = createSyntheticBot(store, { loreCount: scenario.lore });
      const scenes = syntheticStoryScenes(scenario.scenes, { longStory: true });
      const imported = importChatTranscript(store, {
        idempotencyKey: 'benchmark',
        transcript: {
          format: 'uimori-chat-transcript',
          version: 2,
          exportedAt: '2020-01-01T00:00:00.000Z',
          title: 'Synthetic preparation',
          packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
          notes: [],
          entries: scenes.map(({ metrics: _metrics, ...entry }) => entry),
        },
      });
      const chat = imported.chat;
      const profile = store.product.snapshot(chat.id);
      profile.models.main = {
        id: 'synthetic-model',
        revision: 1,
        title: 'Synthetic',
        connectionId: 'synthetic',
        connectionRevision: 1,
        modelId: 'gpt-5.6',
        maxOutputTokens: 8192,
        temperature: null,
        connection: {
          id: 'synthetic',
          revision: 1,
          title: 'Never contacted',
          protocol: 'openai-responses-v1',
          endpoint: 'http://127.0.0.1:1/v1',
          enabled: true,
          catalog: [],
          catalogError: null,
        },
      };
      const snapshot = {
        chatId: chat.id,
        parentRevision: chat.headRevision,
        settingsRevision: chat.settingsRevision,
        settings: chat.settings,
        request: 'Continue. {{setvar::benchmark::ready}}{{getvar::benchmark}}',
        history: store.history(chat.headRevision),
        resources: store.product.resources(chat.id, profile),
        profile,
      };
      snapshot.logicalHistory = captureLogicalHistory(store, snapshot);
      await json(fixtureFile, { snapshot, metrics: scenes.map((entry) => entry.metrics) });
    }
    const fixtureBytes = await readFile(fixtureFile);
    const { snapshot, metrics } = JSON.parse(fixtureBytes);
    const dbBefore = databaseHash(store);
    const inputHash = hash(JSON.stringify(snapshot));
    const changesBefore = store.db.prepare('SELECT total_changes() AS n').get().n;
    let workers = 0;
    const hook = createHook({
      init(_id, type) {
        if (type === 'WORKER') workers++;
      },
    });
    let expected;
    async function flow() {
      globalThis.gc();
      workers = 0;
      const initialRss = process.memoryUsage().rss;
      let peakRss = initialRss;
      const timer = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 5);
      hook.enable();
      const cpu = process.cpuUsage();
      const start = performance.now();
      try {
        const prepared = await prepareNativeRisuRun(snapshot);
        const preparationMs = performance.now() - start;
        const built = buildMainProviderRequest(prepared);
        assert.ok(built.request.prompt.messages.length > scenario.scenes);
        const wire = JSON.stringify(encodeResponses(built.request).body);
        const elapsedMs = performance.now() - start;
        const used = process.cpuUsage(cpu);
        const output = JSON.stringify(prepared);
        const result = {
          preparationMs,
          elapsedMs,
          cpuMs: (used.user + used.system) / 1000,
          initialRss,
          peakRss: Math.max(peakRss, process.memoryUsage().rss),
          workers,
          outputHash: hash(output),
          wireHash: hash(wire),
          wireBytes: Buffer.byteLength(wire),
        };
        assert.equal(prepared.nativeRisuExecution.variables.benchmark, 'ready');
        expected ??= {
          outputHash: result.outputHash,
          wireHash: result.wireHash,
          wireBytes: result.wireBytes,
        };
        for (const [key, value] of Object.entries(expected)) assert.equal(result[key], value);
        return result;
      } finally {
        hook.disable();
        clearInterval(timer);
        await disposeAllNativeRisuSessions();
      }
    }
    const first = await flow();
    for (let i = 0; i < 2; i++) await flow();
    const samples = [];
    for (let i = 0; i < 9; i++) samples.push(await flow());
    assert.equal(databaseHash(store), dbBefore);
    assert.equal(hash(JSON.stringify(snapshot)), inputHash);
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changesBefore);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    const condition = {
      ...scenario,
      fixtureHash: hash(fixtureBytes),
      dbHash: dbBefore,
      metrics,
      first,
      samples,
      summary: Object.fromEntries(
        ['preparationMs', 'elapsedMs', 'cpuMs', 'peakRss'].map((key) => [
          key,
          summary(samples, key),
        ])
      ),
    };
    report.conditions.push(condition);
    console.log(
      JSON.stringify({
        ...scenario,
        summary: condition.summary,
        workers: samples[0].workers,
        wireBytes: samples[0].wireBytes,
      })
    );
  } finally {
    store.close();
  }
}
if (label !== 'baseline') {
  const baseline = JSON.parse(await readFile(path.join(directory, 'baseline.json'), 'utf8'));
  for (const [index, condition] of report.conditions.entries()) {
    const before = baseline.conditions[index];
    assert.equal(condition.fixtureHash, before.fixtureHash);
    assert.equal(condition.dbHash, before.dbHash);
    for (const sample of [condition.first, ...condition.samples])
      for (const key of ['outputHash', 'wireHash', 'wireBytes', 'workers'])
        assert.equal(sample[key], before.samples[0][key]);
  }
}
report.finishedAt = new Date().toISOString();
await json(path.join(directory, `${label}.json`), report);
console.log(`Report: ${path.join(directory, `${label}.json`)}`);
