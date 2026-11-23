import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./perf-ledger.mjs', import.meta.url));
const CANARY = 'Private manuscript canary sentence';

async function fixtureDatabase(t) {
  const { Store } = await import('../dist/server/store.js');
  const directory = await mkdtemp(join(tmpdir(), 'uimori-perf-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'ledger.sqlite');
  const store = new Store(path);
  const at = (offsetMs) => new Date(Date.now() - 86_400_000 + offsetMs).toISOString();
  const db = store.db;
  store.transaction(() => {
    db.prepare(
      "INSERT INTO chats(id,title,settings_revision,settings,created_at) VALUES('chat-canary-id',?,1,'{}',?)"
    ).run(CANARY, at(0));
    const insertRun = db.prepare(
      "INSERT INTO runs(id,chat_id,status,request,snapshot,request_key,command,created_at,updated_at) VALUES(?,'chat-canary-id',?,?,?,?,'{}',?,?)"
    );
    insertRun.run(
      'run-measured-id',
      'completed',
      JSON.stringify({ text: CANARY }),
      JSON.stringify({
        note: CANARY,
        phaseSpans: { contextPlan: 12.5, mainModel: 4200, txCommit: 3, 'free text': 9 },
      }),
      'request-one',
      at(0),
      at(5000)
    );
    insertRun.run('run-legacy-id', 'refused', '{}', '{}', 'request-two', at(10_000), at(12_000));
    db.prepare(
      "INSERT INTO sources(id,chat_id,run_id,text,hash,created_at) VALUES('source-id','chat-canary-id','run-measured-id',?,'hash',?)"
    ).run(CANARY, at(5000));
    const insertAttempt = db.prepare(
      "INSERT INTO attempts(id,chat_id,run_id,role,connection_id,model_id,status,request,response,input_tokens,output_tokens,raw_usage,started_at,usage_kind) VALUES(?,'chat-canary-id',?,'main','connection-id','synthetic-model-1',?,?,?,100,50,?,?,'writing')"
    );
    insertAttempt.run(
      'attempt-new-id',
      'run-measured-id',
      'completed',
      JSON.stringify({ protocol: 'vertex', body: { prompt: CANARY } }),
      JSON.stringify({
        text: CANARY,
        executionDiagnostic: {
          finishedAt: at(4800),
          elapsedMs: 4200,
          firstByteMs: 310,
          firstTextMs: 900,
          streamMs: 3890,
          requestBytes: 2048,
          responseBytes: 4096,
          interCallGapMs: 45_000,
        },
      }),
      JSON.stringify({
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 50,
      }),
      at(600)
    );
    insertAttempt.run(
      'attempt-old-id',
      'run-legacy-id',
      'refused',
      JSON.stringify({ protocol: 'vertex' }),
      JSON.stringify({
        text: CANARY,
        executionDiagnostic: { finishedAt: at(11_000), elapsedMs: 900 },
      }),
      JSON.stringify({ promptTokenCount: 120 }),
      at(10_100)
    );
    const insertEvent = db.prepare(
      "INSERT INTO events(chat_id,kind,entity_id,at) VALUES('chat-canary-id',?,?,?)"
    );
    insertEvent.run('run.queued', 'run-measured-id', at(0));
    insertEvent.run('run.running', 'run-measured-id', at(200));
    insertEvent.run('run.completed', 'run-measured-id', at(5000));
    insertEvent.run('run.refused', 'run-legacy-id', at(12_000));
  });
  store.close();
  return path;
}

function runLedger(args, env, input) {
  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const digest = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

test('ledger reads aggregates from stdin mode without exposing stored text or identifiers', async (t) => {
  const path = await fixtureDatabase(t);
  const before = await digest(path);
  const since = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const output = runLedger(
    ['--input-type=module', '-', '--since', since],
    { UIMORI_DB: path },
    await readFile(script, 'utf8')
  );
  assert.equal(await digest(path), before);
  for (const secret of [CANARY, 'Private', 'chat-canary-id', 'run-measured-id', 'attempt-new-id'])
    assert.equal(output.includes(secret), false, secret);
  const ledger = JSON.parse(output);
  assert.equal(ledger.ledger, 1);
  assert.equal(ledger.since, `${since}T00:00:00.000Z`);
  assert.equal(ledger.database.schemaVersion, 15);
  for (const [name, section] of Object.entries(ledger))
    assert.equal(section?.error, undefined, `${name}: ${section?.error}`);

  const writing = ledger.streaming.windowByUsageKind.writing;
  assert.equal(writing.calls, 2);
  assert.deepEqual(
    [writing.firstByteMs.n, writing.firstByteMs.p50, writing.responseBytes.p95],
    [1, 310, 4096]
  );
  assert.deepEqual(writing.firstThoughtMs, { n: 0 });
  assert.deepEqual(Object.keys(ledger.phaseSpans.window).sort(), [
    'contextPlan',
    'mainModel',
    'txCommit',
  ]);
  assert.equal(ledger.phaseSpans.window.contextPlan.p50, 12.5);
  assert.equal(ledger.phaseSpans.windowCompleted.mainModel.p95, 4200);
  assert.equal(ledger.timeline.completed.window.queueMs.p50, 200);
  assert.equal(ledger.cacheByGap.writing.recordedInterCallGap['<1m'].cacheReadPct, 40);
  assert.deepEqual(ledger.runs.byStatusWindow, { completed: 1, refused: 1 });
  assert.equal(ledger.usage.window[0].key, 'writing/vertex/synthetic-model-1');
});

test('ledger accepts a path argument and reports empty statistics for a database without data', async (t) => {
  const { Store } = await import('../dist/server/store.js');
  const directory = await mkdtemp(join(tmpdir(), 'uimori-perf-ledger-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'empty.sqlite');
  new Store(path).close();
  const ledger = JSON.parse(runLedger([script, path], { UIMORI_DB: '' }));
  assert.deepEqual(ledger.phaseSpans, { window: {}, windowCompleted: {}, all: {} });
  assert.deepEqual(ledger.timeline.completed.window.totalMs, { n: 0 });
  assert.equal(ledger.translation.window.jobs, 0);
});
