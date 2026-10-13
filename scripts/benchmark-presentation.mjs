import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { assertBuild, fingerprint, json, newId, root } from './lib.mjs';
import { Store } from '../dist/server/store.js';
import { settleSnapshot } from '../dist/server/execution-snapshot.js';
import { projectNativeRisuPackage } from '../dist/server/risu-native-projection.js';
import { packagePresentationRoutes } from '../dist/server/package-presentation-routes.js';
import { readerDetail } from '../dist/server/reader.js';

// Reuse the exact synthetic databases for before/after runs. Never accept an app DB.
const directory = path.resolve(
  process.argv[2] ?? path.join(root, 'output/benchmarks', `presentation-${newId()}`)
);
const label = process.argv[3] ?? 'baseline';
assert.match(label, /^[a-z0-9-]+$/u);
const marker = path.join(directory, 'fixture.json');
const identity = await assertBuild();
const scenarios = [
  { scenes: 30, chars: 8000 },
  { scenes: 300, chars: 8000 },
];
if (!existsSync(directory)) {
  await mkdir(directory, { recursive: true });
  await json(marker, { kind: 'uimori-presentation-benchmark-v1', scenarios });
}
assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
  kind: 'uimori-presentation-benchmark-v1',
  scenarios,
});
const hash = (text) => createHash('sha256').update(text).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const source = await fingerprint();
await writeFile(path.join(directory, `${label}.diff`), git('diff', 'HEAD', '--binary'));
const report = {
  startedAt: new Date().toISOString(),
  identity,
  source,
  gitHead: git('rev-parse', 'HEAD').trim(),
  gitStatus: git('status', '--porcelain=v1'),
  environment: {
    node: process.version,
    sqlite: process.versions.sqlite,
    platform: os.platform(),
    release: os.release(),
    cpu: os.cpus()[0].model,
    memory: os.totalmem(),
  },
  method: {
    boundary:
      'Fastify reader injection start through last five concurrent presentation responses, including serialization; no browser paint/network',
    first: 'First measured flow in this process; OS cache is not reset',
    warmups: 2,
    samples: 9,
    fixture:
      '30/300 completed synthetic scenes, 8000 UTF-16 chars each, settled snapshots; real file SQLite and native render workers',
    resources:
      'Process CPU includes workers; RSS sampled every 5ms (synchronous peaks can be missed); no paid models/network',
    acceptance:
      'Long scenario median saves at least 50ms and 10%, normal scenario no material regression, identical responses and unchanged DB; no cache/schema/dependency',
  },
  conditions: [],
};
globalThis.fetch = () => {
  throw new Error('External calls forbidden in benchmark');
};
for (const scenario of scenarios) {
  const dbPath = path.join(directory, `scenes-${scenario.scenes}.sqlite`);
  const fresh = !existsSync(dbPath);
  const store = new Store(dbPath);
  const app = Fastify();
  try {
    if (fresh) {
      const card = { name: 'Synthetic benchmark', description: 'A local story.' };
      const pkg = projectNativeRisuPackage(
        {
          version: 2,
          id: 'benchmark-card',
          revision: 1,
          title: card.name,
          description: '',
          lore: [],
          nativeRisu: { version: 1, card, assets: [], sourceHash: hash(JSON.stringify(card)) },
        },
        'bot'
      ).pkg;
      const bot = store.product.content({
        kind: 'bot',
        title: card.name,
        description: '',
        text: '',
        loading: 'pinned',
        relatedIds: [],
        package: pkg,
      });
      const chat = store.createChat('Synthetic benchmark', { botId: bot.id });
      const profile = store.product.snapshot(chat.id);
      const run = store.db.prepare(
        "INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,source_revision,created_at,updated_at) VALUES(?,?,?,'completed',?,?,?,?,?,?,?)"
      );
      const insert = store.db.prepare(
        'INSERT INTO sources(id,chat_id,run_id,parent_revision,text,hash,created_at) VALUES(?,?,?,?,?,?,?)'
      );
      store.transaction(() => {
        let parent = null;
        for (let i = 0; i < scenario.scenes; i++) {
          const id = `source-${i}`,
            runId = `run-${i}`,
            time = new Date(Date.UTC(2020, 0, 1) + i).toISOString();
          const text = (
            `Scene ${i}. 비가 내리는 항구에서 두 사람은 다시 만났다.\n\n` +
            '그는 오래된 편지를 펼쳤다. 다음 날의 약속을 기억했다.\n\n'.repeat(300)
          ).slice(0, scenario.chars);
          const request = `Continue scene ${i}`;
          const snapshot = settleSnapshot({
            chatId: chat.id,
            parentRevision: parent,
            settingsRevision: chat.settingsRevision,
            settings: chat.settings,
            request,
            history: [],
            resources: [],
            profile,
          });
          run.run(
            runId,
            chat.id,
            parent,
            request,
            JSON.stringify(snapshot),
            runId,
            '{}',
            id,
            time,
            time
          );
          insert.run(id, chat.id, runId, parent, text, hash(text), time);
          store.event(chat.id, 'run.completed', runId);
          parent = id;
        }
        store.db.prepare('UPDATE chats SET head_revision=? WHERE id=?').run(parent, chat.id);
      });
    }
    const chatId = String(store.db.prepare('SELECT id FROM chats').get().id);
    const fixtureRows = store.db.prepare('SELECT id,text,hash FROM sources ORDER BY rowid').all();
    assert.equal(fixtureRows.length, scenario.scenes);
    assert.ok(fixtureRows.every((row) => row.text.length === scenario.chars));
    const contentHash = hash(JSON.stringify(fixtureRows));
    packagePresentationRoutes(app, store);
    app.get('/benchmark/reader', () =>
      readerDetail(store, chatId, { source: `source-${scenario.scenes - 1}` })
    );
    await app.ready();
    let counters;
    for (const [owner, key] of [
      [store, 'history'],
      [store.story, 'prepare'],
      [store.product, 'resources'],
    ]) {
      const original = owner[key].bind(owner);
      owner[key] = (...args) => {
        const start = performance.now();
        try {
          return original(...args);
        } finally {
          if (counters) {
            counters[key].calls++;
            counters[key].ms += performance.now() - start;
          }
        }
      };
    }
    const originalPrepare = store.db.prepare.bind(store.db);
    store.db.prepare = (...args) => {
      if (counters) counters.sqlStatements++;
      return originalPrepare(...args);
    };
    let expected;
    const changesBefore = store.db.prepare('SELECT total_changes() AS n').get().n;
    async function flow() {
      globalThis.gc?.();
      counters = {
        history: { calls: 0, ms: 0 },
        prepare: { calls: 0, ms: 0 },
        resources: { calls: 0, ms: 0 },
        sqlStatements: 0,
      };
      const cpu = process.cpuUsage(),
        initialRss = process.memoryUsage().rss;
      let peakRss = initialRss;
      const timer = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 5);
      const start = performance.now();
      try {
        const reader = await app.inject('/benchmark/reader');
        assert.equal(reader.statusCode, 200, reader.body);
        const readerMs = performance.now() - start;
        const responses = await Promise.all(
          reader
            .json()
            .reader.order.map((id) => app.inject(`/api/chats/${chatId}/sources/${id}/presentation`))
        );
        const elapsedMs = performance.now() - start;
        const used = process.cpuUsage(cpu);
        for (const response of responses) assert.equal(response.statusCode, 200, response.body);
        const bodies = [reader.body, ...responses.map((response) => response.body)];
        const responseHash = hash(JSON.stringify(bodies));
        expected ??= responseHash;
        assert.equal(responseHash, expected);
        return {
          elapsedMs,
          readerMs,
          cpuMs: (used.user + used.system) / 1000,
          initialRss,
          peakRss: Math.max(peakRss, process.memoryUsage().rss),
          responseBytes: bodies.reduce((n, body) => n + Buffer.byteLength(body), 0),
          responseHash,
          ...counters,
        };
      } finally {
        clearInterval(timer);
        counters = null;
      }
    }
    const first = await flow();
    for (let i = 0; i < 2; i++) await flow();
    const samples = [];
    for (let i = 0; i < 9; i++) samples.push(await flow());
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changesBefore);
    assert.equal(
      hash(
        JSON.stringify(store.db.prepare('SELECT id,text,hash FROM sources ORDER BY rowid').all())
      ),
      contentHash
    );
    const summary = Object.fromEntries(
      ['elapsedMs', 'readerMs', 'cpuMs', 'peakRss'].map((key) => {
        const values = samples.map((row) => row[key]).sort((a, b) => a - b);
        return [key, { median: values[4], min: values[0], max: values.at(-1) }];
      })
    );
    report.conditions.push({ ...scenario, contentHash, first, samples, summary });
    console.log(JSON.stringify({ ...scenario, summary, counters: samples[4] }));
  } finally {
    await app.close();
    store.close();
  }
}
if (label !== 'baseline' && existsSync(path.join(directory, 'baseline.json'))) {
  const baseline = JSON.parse(await readFile(path.join(directory, 'baseline.json'), 'utf8'));
  for (const [index, condition] of report.conditions.entries()) {
    const before = baseline.conditions[index];
    assert.equal(condition.contentHash, before.contentHash);
    for (const sample of condition.samples) {
      assert.equal(sample.responseHash, before.samples[0].responseHash);
      assert.equal(sample.responseBytes, before.samples[0].responseBytes);
    }
  }
}
report.finishedAt = new Date().toISOString();
await json(path.join(directory, `${label}.json`), report);
console.log(`Report: ${path.join(directory, `${label}.json`)}`);
