import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./eval-early-refusal.mjs', import.meta.url));
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const CANARY = 'Private manuscript canary sentence.';
const REFUSAL = 'I cannot continue this story.';
const CHARACTER_REFUSAL = 'She said no.';
const KEY = 'synthetic-eval-key';

const filler = (length) => CANARY.repeat(Math.ceil(length / CANARY.length)).slice(0, length);
const paragraphs = (count) => Array.from({ length: count }, () => filler(198)).join('\n\n');
const texts = {
  refusalFirst: `${REFUSAL}\n\n${filler(4000)}`,
  refusalLater: `${filler(1000)}\n\n${REFUSAL}\n\n${filler(3000)}`,
  refusalShort: REFUSAL,
  characterRefusal: `${CHARACTER_REFUSAL}\n\n${paragraphs(17)}`,
  plain: filler(2000),
};

const stub = `import { appendFileSync } from 'node:fs';
export default async function (url, init) {
  const body = JSON.parse(init.body);
  appendFileSync(process.env.UIMORI_EVAL_STUB_LOG, JSON.stringify({
    url,
    authorization: new Headers(init.headers).get('authorization'),
    body,
  }) + '\\n');
  const text = body.state.response;
  const noul = text.includes(${JSON.stringify(REFUSAL)}) ? 0.95 : text.includes(${JSON.stringify(CHARACTER_REFUSAL)}) ? 0.62 : 0.05;
  return Response.json({
    model: 'jev-latest',
    answers: { explicitRefusal: { type: 'noul', noul } },
    usage: { input_tokens: 10, output_tokens: 1 },
  });
}
`;

async function fixture(t) {
  const { Store } = await import('../dist/server/store.js');
  const { JevCredentialStore } = await import('../dist/server/jev-credentials.js');
  const { mainJudgmentInput } = await import('../dist/server/main-judgment.js');
  const directory = await mkdtemp(join(tmpdir(), 'uimori-eval-early-refusal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'evaluation.sqlite');
  const store = new Store(path);
  new JevCredentialStore(store.db).update(0, KEY);
  const at = new Date().toISOString();
  store.transaction(() => {
    store.db
      .prepare(
        "INSERT INTO chats(id,title,settings_revision,settings,created_at) VALUES('chat-canary-id',?,1,'{}',?)"
      )
      .run(CANARY, at);
    const insertRun = store.db.prepare(
      "INSERT INTO runs(id,chat_id,status,request,snapshot,request_key,command,error,created_at,updated_at) VALUES(?,'chat-canary-id',?,?,?,?,'{}',?,?,?)"
    );
    const run = (id, status, error, snapshot) =>
      insertRun.run(id, status, CANARY, JSON.stringify(snapshot), id, error, at, at);
    const judged = (text) => ({ mainJudgment: mainJudgmentInput(text, 0.9) });
    run('run-refusal-first', 'refused', 'MAIN_RESPONSE_REFUSED', judged(texts.refusalFirst));
    run('run-refusal-duplicate', 'refused', 'MAIN_RESPONSE_REFUSED', judged(texts.refusalFirst));
    run('run-refusal-later', 'refused', 'MAIN_RESPONSE_REFUSED', judged(texts.refusalLater));
    run('run-refusal-short', 'refused', 'MAIN_RESPONSE_REFUSED', judged(texts.refusalShort));
    run('run-empty', 'refused', 'EMPTY_COMPLETION', judged(texts.refusalFirst));
    const insertSource = store.db.prepare(
      "INSERT INTO sources(id,chat_id,run_id,text,hash,created_at) VALUES(?,'chat-canary-id',?,?,'hash',?)"
    );
    for (const [id, text] of [
      ['character', texts.characterRefusal],
      ['plain', texts.plain],
      ['plain-duplicate', texts.plain],
    ]) {
      run(`run-${id}`, 'completed', null, { mainJudgmentEnabled: true });
      insertSource.run(`source-${id}`, `run-${id}`, text, at);
    }
  });
  store.close();
  const stubPath = join(directory, 'judgment-stub.mjs');
  await writeFile(stubPath, stub);
  return { path, stubPath, log: join(directory, 'calls.jsonl') };
}

function evaluate(args, environment, input) {
  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, TYPESAFE_API_KEY: '', ...environment },
    input,
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

const digest = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

const calls = async (log) =>
  existsSync(log)
    ? (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];

test('evaluation replays the server judgment on prefixes and prints only aggregates', async (t) => {
  const { path, stubPath, log } = await fixture(t);
  const before = await digest(path);
  const environment = {
    UIMORI_DB: path,
    UIMORI_EVAL_JUDGMENT_FETCH: stubPath,
    UIMORI_EVAL_STUB_LOG: log,
  };
  const run = evaluate(
    ['--input-type=module', '-', '--dist', dist],
    environment,
    await readFile(script, 'utf8')
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await digest(path), before);
  for (const secret of [CANARY, 'Private', REFUSAL, CHARACTER_REFUSAL, 'chat-canary-id', KEY])
    assert.equal(run.stdout.includes(secret), false, secret);

  const { mainJudgmentRequest } = await import('../dist/server/main-judgment.js');
  const requests = await calls(log);
  assert.equal(requests.length, 16);
  for (const request of requests) {
    assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(request.authorization, `Bearer ${KEY}`);
    assert.deepEqual(request.body, {
      model: 'jev-latest',
      ...mainJudgmentRequest({ response: request.body.state.response }),
    });
  }

  const report = JSON.parse(run.stdout);
  assert.equal(report.calls, 16);
  assert.equal(report.errors, 0);
  assert.equal(report.pool.positiveRows, 3 + 1);
  assert.equal(report.pool.uniquePositives, 3);
  assert.equal(report.pool.uniqueNegatives, 2);
  assert.deepEqual(report.pool.judgedRuns, {
    'refused/MAIN_RESPONSE_REFUSED': 4,
    'refused/EMPTY_COMPLETION': 1,
  });
  assert.deepEqual(report.planned.prefixCalls, { 500: 4, 1500: 4, 3000: 3 });

  const { positives, negatives } = report;
  assert.deepEqual(positives.control.reproduced, { count: 3, rate: 1 });
  assert.deepEqual(negatives.control.reproduced, { count: 2, rate: 1 });
  assert.equal(positives.byPrefix['500'].samples, 2);
  assert.equal(positives.byPrefix['500'].shorterThanPrefix, 1);
  assert.deepEqual(positives.byPrefix['500'].atRunThreshold, { count: 1, rate: 0.5 });
  assert.deepEqual(positives.byPrefix['1500'].atRunThreshold, { count: 2, rate: 1 });
  assert.deepEqual(positives.byPrefix['3000'].atThreshold['0.99'], { count: 0, rate: 0 });
  assert.equal(positives.byPrefix['500'].cuts.hard, 2);
  assert.equal(
    positives.byPrefix['3000'].detectedFollowingChars.n,
    positives.byPrefix['3000'].samples
  );

  assert.equal(negatives.byPrefix['500'].samples, 2);
  assert.equal(negatives.byPrefix['3000'].samples, 1);
  assert.equal(negatives.byPrefix['500'].cuts.paragraph, 1);
  assert.deepEqual(negatives.byPrefix['500'].atThreshold['0.6'], { count: 1, rate: 0.5 });
  assert.deepEqual(negatives.byPrefix['500'].atThreshold['0.7'], { count: 0, rate: 0 });
  assert.deepEqual(negatives.byPrefix['1500'].atRunThreshold, { count: 0, rate: 0 });
  assert.equal(negatives.byPrefix['1500'].maxScore, 0.62);
});

test('dry run and the call cap make no judgment calls', async (t) => {
  const { path, stubPath, log } = await fixture(t);
  const environment = { UIMORI_EVAL_JUDGMENT_FETCH: stubPath, UIMORI_EVAL_STUB_LOG: log };

  const dryRun = evaluate([script, path, '--dist', dist, '--dry-run'], environment);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const planned = JSON.parse(dryRun.stdout);
  assert.equal(planned.planned.calls, 16);
  assert.equal(planned.credential, 'configured');

  const sampled = evaluate(
    [script, path, '--dist', dist, '--dry-run', '--limit-positives', '1', '--limit-negatives=1'],
    environment
  );
  assert.deepEqual(JSON.parse(sampled.stdout).sampled, { positives: 1, negatives: 1 });

  const capped = evaluate([script, path, '--dist', dist, '--max-calls', '15'], environment);
  assert.equal(capped.status, 2);
  assert.equal(JSON.parse(capped.stdout).aborted, 'max-calls');
  assert.deepEqual(await calls(log), []);
});
