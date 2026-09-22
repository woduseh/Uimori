import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { readerDetail, readerRuns } from '../server/reader.js';
import { readerPresentationRevisions } from '../server/reader-data.js';
import { readerRequestOrder } from '../core/reader-conversation.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { releaseCompletedJobInputs } from '../server/execution-retention.js';
import { DATABASE_SCHEMA_VERSION } from '../server/database-schema.js';

const owned: { store: Store; path: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0)) {
    item.store.close();
    rmSync(item.path, { recursive: true, force: true });
  }
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-audit-cleanup-'));
  const owner = { store: new Store(join(path, 'app.sqlite')), path };
  owned.push(owner);
  const store = owner.store;
  const bot = store.product.content(fixtureBotInput());
  const chat = importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      title: 'Audit fixture',
      exportedAt: new Date().toISOString(),
      packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
      notes: [],
      entries: [
        { request: 'First', text: 'First scene.', translation: '첫 장면.' },
        { request: 'Second', text: 'Second scene.', translation: '둘째 장면.' },
      ],
    },
  }).chat;
  const sources = store.history(chat.headRevision).map((item) => store.source(item.revision));
  const branch = store.product.branch(chat.id);
  return { owner, store, chat, sources, branch };
}

test('display revisions ignore progress and unrelated branch variables, but track authored changes', () => {
  const { store, chat, branch, sources } = fixture();
  const read = () =>
    readerPresentationRevisions(
      store,
      chat.id,
      branch.id,
      sources.map((s) => s.id)
    );
  const initial = read();
  for (const kind of ['run.usage', 'run.running', 'job.queued', 'job.running', 'chat.renamed'])
    store.event(chat.id, kind, 'synthetic-progress');
  store.event(chat.id, 'chat.variables.changed', 'another-branch');
  expect(read()).toEqual(initial);
  store.event(chat.id, 'chat.variables.changed', branch.id);
  const variables = read();
  expect(variables).not.toEqual(initial);
  store.event(chat.id, 'source.edited', sources[0]!.id);
  expect(read()).not.toEqual(variables);
});

test('reader input projection does not parse discarded diagnostic bodies', () => {
  const { store, sources } = fixture();
  const job = store.db
    .prepare("SELECT id FROM jobs WHERE source_revision=? AND kind='translation'")
    .get(sources[0]!.id)!;
  const marker = 'PRIVATE_DIAGNOSTIC_' + 'x'.repeat(16384);
  store.db
    .prepare('UPDATE jobs SET input=? WHERE id=?')
    .run(JSON.stringify({ inputs: [marker] }), job.id);
  const parse = vi.spyOn(JSON, 'parse');
  const light = store.job(String(job.id), 'reader');
  expect(light.result?.text).toBe('첫 장면.');
  expect(light.input).toBeNull();
  expect(parse.mock.calls.some(([value]) => value.includes(marker))).toBe(false);
  const full = store.job(String(job.id));
  expect(full.input).toEqual({ inputs: [marker] });
});

test('reader hydrates the visible retry, while the task history still contains superseded failures', () => {
  const { store, chat, branch } = fixture();
  const insert =
    store.db.prepare(`INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,created_at,updated_at,branch_id)
    VALUES(?,?,?,'failed',?,?,?,?,?,?,?)`);
  store.transaction(() => {
    for (let i = 0; i < 120; i++) {
      const id = `failed-${i}`;
      const time = new Date(Date.now() + i).toISOString();
      const snapshot = {
        chatId: chat.id,
        branchId: branch.id,
        parentRevision: chat.headRevision,
        request: 'Retry',
        settings: chat.settings,
        settingsRevision: chat.settingsRevision,
        history: [],
        resources: [],
      };
      insert.run(
        id,
        chat.id,
        chat.headRevision,
        'Retry',
        JSON.stringify(snapshot),
        id,
        JSON.stringify(i ? { retryOf: `failed-${i - 1}` } : {}),
        time,
        time,
        branch.id
      );
    }
  });
  const detail = readerDetail(store, chat.id, {});
  expect(detail.reader.pendingRunIds).toEqual(['failed-119']);
  expect(detail.runs.filter((run) => !run.sourceRevision).map((run) => run.id)).toEqual([
    'failed-119',
  ]);
  expect(readerRuns(store, chat.id).filter((run) => !run.sourceRevision)).toHaveLength(120);
});

test('shared retry order cache traverses ancestry once rather than once per retry', () => {
  const rows = new Map(
    Array.from({ length: 500 }, (_, i) => [
      String(i),
      {
        id: String(i),
        admissionOrder: i + 1,
        retryOf: i ? String(i - 1) : null,
      },
    ])
  );
  const get = vi.spyOn(rows, 'get');
  const cache = new Map<string, number>();
  for (const id of rows.keys()) expect(readerRequestOrder(rows, id, cache)).toBe(1);
  expect(get.mock.calls.length).toBeLessThan(1500);
});

test('completed auxiliary diagnostics are released without dropping dependent image selection', () => {
  const { store, sources } = fixture();
  const row = store.db
    .prepare("SELECT id FROM jobs WHERE source_revision=? AND kind='translation'")
    .get(sources[0]!.id)!;
  const selection = { imageCatalog: { entries: [{ ref: 'saved-image' }] } };
  store.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(
    JSON.stringify({
      initial: { body: 'large' },
      inputs: ['diagnostic'],
      toolEvents: ['tool'],
      translationImageSelection: selection,
      translationPolicy: { language: 'ko' },
    }),
    row.id
  );
  releaseCompletedJobInputs(store.db, String(row.id));
  expect(store.job(String(row.id)).input).toEqual({
    translationImageSelection: selection,
    translationPolicy: { language: 'ko' },
  });
  expect(store.job(String(row.id)).result?.text).toBe('첫 장면.');
});

test('successful helper messages replace cumulative inputs; failed tasks retain retry context', () => {
  const { store } = fixture();
  const workspace = new HelperWorkspace(store);
  const conversation = workspace.open({ kind: 'library', workId: 'audit' });
  const connection = store.product.connection({
    title: 'Fixture',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Fixture',
    connectionId: connection.id,
    modelId: 'fixture',
    temperature: null,
    maxOutputTokens: 1024,
  });
  for (const status of ['completed', 'failed'] as const) {
    const task = workspace.enqueue(conversation.id, randomUUID(), 'Explain', {
      scope: conversation.scope,
      model: store.product.modelSnapshot(model.id),
      history: [{ id: 'old', role: 'assistant', text: 'Prior large conversation.' }],
      persona: '',
      limits: { totalCalls: 4, helperCalls: 4, artifacts: 1 },
    });
    expect(workspace.start(task.id, 'owner')).toBe(true);
    workspace.finish(task.id, 'owner', 1, status, 'Saved answer', null);
    expect(workspace.task(task.id).snapshot.history).toHaveLength(status === 'completed' ? 0 : 1);
    expect(
      store.db
        .prepare("SELECT text FROM helper_messages WHERE task_id=? AND role='assistant'")
        .get(task.id)?.text
    ).toBe('Saved answer');
  }
});

test('schema 1 upgrades once, removes grants, and preserves manuscripts and ordinary pending options', () => {
  const { owner, store, chat, branch, sources } = fixture();
  const original = sources.map((source) => source.text);
  store.db.exec(
    "CREATE TABLE helper_delegations(id TEXT); INSERT INTO helper_delegations VALUES('retired'); PRAGMA user_version=1"
  );
  const insert = store.db.prepare('INSERT INTO chat_option_pending VALUES(?,?,?,?)');
  insert.run('retired', chat.id, branch.id, JSON.stringify({ kind: 'delegated' }));
  insert.run(
    'kept',
    chat.id,
    branch.id,
    JSON.stringify({ kind: 'oneoff', values: { tone: 'calm' } })
  );
  store.close();
  owner.store = new Store(join(owner.path, 'app.sqlite'));
  const reopened = owner.store;
  expect(reopened.db.prepare('PRAGMA user_version').get()?.user_version).toBe(
    DATABASE_SCHEMA_VERSION
  );
  expect(
    reopened.db.prepare("SELECT name FROM sqlite_schema WHERE name='helper_delegations'").get()
  ).toBeUndefined();
  expect(
    reopened.db
      .prepare('SELECT id FROM chat_option_pending')
      .all()
      .map((row) => row.id)
  ).toEqual(['kept']);
  expect(reopened.history(chat.headRevision).map((item) => item.text)).toEqual(original);
  expect(reopened.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
