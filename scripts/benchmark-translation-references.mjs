import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../dist/server/store.js';
import { translationReferences } from '../dist/server/translation-context.js';
import { createSyntheticBot } from './synthetic-story.mjs';
import { assertBuild, fingerprint, json, root } from './lib.mjs';

// Reuse only this runner's isolated fixtures; never point it at an application DB.
const directory = path.resolve(process.argv[2]);
const label = process.argv[3] ?? 'baseline';
assert.match(label, /^[a-z0-9-]+$/u);
assert.ok(globalThis.gc, 'Use node --expose-gc');
const scenarios = [30, 300].map((scenes) => ({
  scenes,
  sourceChars: 16000,
  translationChars: 8000,
}));
const marker = { kind: 'uimori-translation-references-v1', scenarios };
if (!existsSync(directory)) {
  await mkdir(directory, { recursive: true });
  await json(path.join(directory, 'fixture.json'), marker);
}
assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'fixture.json'), 'utf8')), marker);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const report = {
  build: await assertBuild(),
  source: await fingerprint(),
  gitHead: git('rev-parse', 'HEAD').trim(),
  gitStatus: git('status', '--porcelain=v1'),
  runnerHash: hash(await readFile(new URL(import.meta.url))),
  environment: {
    node: process.version,
    sqlite: process.versions.sqlite,
    platform: os.platform(),
    cpu: os.cpus()[0].model,
  },
  method: {
    boundary:
      'translationReferences: prior wording preparation used by auxiliaryBridge.load before translation execution',
    excluded:
      'Current job/snapshot preparation, provider/model calls, browser and network latency; OS cache not reset',
    fixture:
      '30/300 completed translations, 16000-char originals and 8000-char wording; no retained job inputs (conservative manual-translation case)',
    warmups: 2,
    samples: 9,
    resources:
      'Process CPU and heap/RSS at entry/return; synchronous peaks are not measured; explicit GC outside timing',
    acceptance:
      'Same exact reference output and unchanged stored rows; long-case median saves at least 50ms and 15%; no material normal-case regression',
  },
  conditions: [],
};
await writeFile(path.join(directory, `${label}.diff`), git('diff', 'HEAD', '--binary'));
await writeFile(
  path.join(directory, `${label}-runner.mjs`),
  await readFile(new URL(import.meta.url))
);
globalThis.fetch = () => {
  throw new Error('External calls forbidden in benchmark');
};
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
const summary = (samples, key) => {
  const values = samples.map((sample) => sample[key]).sort((a, b) => a - b);
  return { median: values[Math.floor(values.length / 2)], min: values[0], max: values.at(-1) };
};
for (const scenario of scenarios) {
  const dbPath = path.join(directory, `scenes-${scenario.scenes}.sqlite`);
  const fresh = !existsSync(dbPath);
  const store = new Store(dbPath);
  try {
    if (fresh) {
      const bot = createSyntheticBot(store);
      const chat = store.createChat('Synthetic translation reference measurement', {
        botId: bot.id,
      });
      const run = store.db.prepare(
        "INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,source_revision,created_at,updated_at) VALUES(?,?,?,'completed',?,'{}',?,'{}',?,?,?)"
      );
      const source = store.db.prepare(
        'INSERT INTO sources(id,chat_id,run_id,parent_revision,text,hash,created_at) VALUES(?,?,?,?,?,?,?)'
      );
      const job = store.db.prepare(
        "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,generation,created_at,updated_at) VALUES(?,?,?,?,'translation','completed',1,1,?,?)"
      );
      const result = store.db.prepare(
        'INSERT INTO job_results(job_id,generation,result,created_at) VALUES(?,1,?,?)'
      );
      store.transaction(() => {
        let parent = null;
        for (let index = 0; index < scenario.scenes; index++) {
          const id = `source-${index}`,
            runId = `run-${index}`,
            jobId = `translation-${index}`;
          const time = new Date(Date.UTC(2020, 0, 1) + index).toISOString();
          const original = (
            `Scene ${index}.\n\n` +
            'Mira opened the old ledger beside the harbor. The promised date was still uncertain.\n\n'.repeat(
              300
            )
          ).slice(0, scenario.sourceChars);
          const wording = (
            `장면 ${index}.\n\n` +
            '미라는 항구에서 오래된 장부를 펼쳤다. 약속한 날짜는 아직 확실하지 않았다.\n\n'.repeat(
              300
            )
          ).slice(0, scenario.translationChars);
          const sourceHash = hash(original);
          run.run(runId, chat.id, parent, `Continue ${index}`, runId, id, time, time);
          source.run(id, chat.id, runId, parent, original, sourceHash, time);
          job.run(jobId, chat.id, id, sourceHash, time, time);
          result.run(
            jobId,
            JSON.stringify({
              mock: false,
              manual: true,
              text: wording,
              sourceRevision: id,
              sourceHash,
            }),
            time
          );
          parent = id;
        }
        store.db.prepare('UPDATE chats SET head_revision=? WHERE id=?').run(parent, chat.id);
      });
    }
    const chatId = String(store.db.prepare('SELECT id FROM chats').get().id);
    const rows = store.db.prepare('SELECT id,text,hash FROM sources ORDER BY rowid').all();
    assert.equal(rows.length, scenario.scenes);
    assert.ok(rows.every((row) => row.text.length === scenario.sourceChars));
    const snapshot = {
      chatId,
      history: rows.map((row) => ({ revision: row.id, text: row.text, contentHash: row.hash })),
    };
    const expected = rows.map((row, index) => {
      const saved = JSON.parse(
        String(
          store.db
            .prepare('SELECT result FROM job_results WHERE job_id=?')
            .get(`translation-${index}`).result
        )
      );
      assert.equal(saved.text.length, scenario.translationChars);
      return {
        id: `translation-${index}`,
        revision: 1,
        sourceRevision: row.id,
        sourceHash: row.hash,
        text: saved.text,
        manual: true,
      };
    });
    const fixtureHash = databaseHash(store);
    const changesBefore = store.db.prepare('SELECT total_changes() AS n').get().n;
    const originalPrepare = store.db.prepare.bind(store.db);
    let counters;
    store.db.prepare = (...args) => {
      if (counters) counters.sqlStatements++;
      const statement = originalPrepare(...args);
      const get = statement.get.bind(statement);
      statement.get = (...parameters) => {
        const row = get(...parameters);
        if (counters && row) {
          counters.returnedTextBytes += Object.values(row).reduce(
            (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
            0
          );
        }
        return row;
      };
      return statement;
    };
    function flow() {
      globalThis.gc();
      counters = { sqlStatements: 0, returnedTextBytes: 0 };
      const memory = process.memoryUsage(),
        cpu = process.cpuUsage(),
        start = performance.now();
      const references = translationReferences(store, snapshot);
      const ms = performance.now() - start,
        used = process.cpuUsage(cpu),
        after = process.memoryUsage();
      const sample = {
        ms,
        cpuMs: (used.user + used.system) / 1000,
        heapDelta: after.heapUsed - memory.heapUsed,
        rssAfter: after.rss,
        ...counters,
      };
      counters = undefined;
      assert.deepEqual(references, expected);
      return sample;
    }
    const first = flow();
    for (let i = 0; i < 2; i++) flow();
    const samples = Array.from({ length: 9 }, flow);
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changesBefore);
    assert.equal(databaseHash(store), fixtureHash);
    const condition = {
      ...scenario,
      fixtureHash,
      inputHash: hash(JSON.stringify(snapshot)),
      outputHash: hash(JSON.stringify(expected)),
      first,
      samples,
      summary: Object.fromEntries(Object.keys(first).map((key) => [key, summary(samples, key)])),
    };
    report.conditions.push(condition);
    console.log(JSON.stringify({ scenes: scenario.scenes, ...condition.summary }));
  } finally {
    store.close();
  }
}
await json(path.join(directory, `${label}.json`), report);
console.log(`Report: ${path.join(directory, `${label}.json`)}`);
