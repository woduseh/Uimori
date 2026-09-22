import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ChatOptionsStore } from '../server/chat-options.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { nativePrompt } from './fixtures/native-prompt.js';
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

function optionsFor(store: Store, chatId: string) {
  const prior = promptWorkspace(store);
  updatePromptWorkspace(store, {
    expectedRevision: prior.revision,
    main: {
      ...prior.main,
      program: nativePrompt('Synthetic prompt. '.repeat(4096), {
        customPromptTemplateToggle: 'tone=Tone=text',
      }),
      values: { tone: 'calm' },
    },
  });
  const options = new ChatOptionsStore(store);
  const body = (values: Record<string, string>) => {
    const state = options.get(chatId);
    return {
      branchId: state.branchId,
      expectedRevision: state.revision,
      binding: state.binding,
      values,
      operationId: randomUUID(),
    };
  };
  return { options, body };
}

test('oneoff settings survive source edits and consume once without reading manuscript history', () => {
  const { store, chat, branch } = fixture();
  const { options, body } = optionsFor(store, chat.id);
  const history = vi.spyOn(store, 'history');
  const requested = body({ tone: 'warm' });
  options.stage(chat.id, requested, 'user');
  expect(history).not.toHaveBeenCalled();
  const source = store.source(branch.headRevision!);
  store.editSource(source.id, {
    text: source.text + ' A correction.',
    expectedRevision: source.editRevision ?? 0,
  });
  expect(options.get(chat.id).conflicts).toEqual([]);
  const command = {
    request: 'Continue',
    expectedRevision: branch.headRevision,
    expectedSettingsRevision: chat.settingsRevision,
    branchId: branch.id,
    idempotencyKey: randomUUID(),
  };
  const run = store.createRun(chat.id, command, (c) => ({
    chatId: c.id,
    parentRevision: branch.headRevision,
    request: command.request,
    settingsRevision: c.settingsRevision,
    settings: c.settings,
    history: store.history(branch.headRevision),
    resources: [],
    profile: store.product.snapshot(c.id),
  }));
  expect(run.run.snapshot.profile!.chatOptions!.values).toEqual({ tone: 'warm' });
  expect(options.get(chat.id).pending).toEqual([]);
  expect(options.stage(chat.id, requested, 'user').pending).toEqual([]);
  expect(store.db.prepare('SELECT count(*) AS n FROM chat_option_pending').get()?.n).toBe(0);
});

test('option receipts contain no prompt copies and only the current oneoff is stored', () => {
  const { store, chat } = fixture();
  const { options, body } = optionsFor(store, chat.id);
  const first = body({ tone: 'warm' });
  options.fixed(chat.id, first, 'user');
  for (let i = 0; i < 20; i++) options.fixed(chat.id, body({ tone: String(i) }), 'user');
  expect(options.fixed(chat.id, first, 'user').fixedValues).toEqual({ tone: '19' });
  const columns = store.db
    .prepare('PRAGMA table_info(chat_option_operations)')
    .all()
    .map((r) => r.name);
  expect(columns).not.toEqual(expect.arrayContaining(['command', 'intent', 'result']));
  expect(columns).toContain('revision');
  const receipts = store.db.prepare('SELECT * FROM chat_option_operations').all();
  expect(Buffer.byteLength(JSON.stringify(receipts))).toBeLessThan(12000);
  for (let i = 0; i < 20; i++) options.stage(chat.id, body({ tone: String(i) }), 'user');
  const state = options.get(chat.id);
  expect(state.pending).toHaveLength(1);
  expect(store.db.prepare('SELECT count(*) AS n FROM chat_option_pending').get()?.n).toBe(1);
  options.cancel(
    chat.id,
    state.pending[0]!.id,
    { branchId: state.branchId, expectedRevision: state.revision, operationId: randomUUID() },
    'user'
  );
  expect(store.db.prepare('SELECT count(*) AS n FROM chat_option_pending').get()?.n).toBe(0);
});

test('helper events and artifact revisions do not duplicate large read results or generation context', () => {
  const { store } = fixture();
  const workspace = new HelperWorkspace(store),
    conversation = workspace.open({ kind: 'library', workId: 'retention' });
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
  const task = workspace.enqueue(conversation.id, randomUUID(), 'Review', {
    scope: conversation.scope,
    model: store.product.modelSnapshot(model.id),
    history: [{ id: 'prior', role: 'assistant', text: 'x'.repeat(1024 * 1024) }],
    persona: '',
    limits: { totalCalls: 8, helperCalls: 8, artifacts: 1 },
  });
  workspace.start(task.id, 'owner');
  const result = { text: 'r'.repeat(256 * 1024) };
  for (let i = 0; i < 5; i++)
    workspace.event(conversation.id, task.id, 'tool.finished', {
      name: 'resource.read',
      denied: false,
      result,
    });
  const updates = workspace.events(conversation.id, 0, 'updates');
  expect(updates.every((e) => e.data === null)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(updates))).toBeLessThan(4000);
  workspace.operation(task.id, 'read-receipt', {}, () => result);
  const usage = { modelCalls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const artifact = workspace.saveArtifact(task.id, 'artifact', 'Draft', 'A short draft.', usage);
  workspace.finish(task.id, 'owner', 1, 'completed', 'Done', null, [
    { id: artifact.id, revision: artifact.revision },
  ]);
  const edited = workspace.editArtifact(artifact.id, 1, 'Edit 1', 'edit-1');
  workspace.editArtifact(artifact.id, 2, 'Edit 2', 'edit-2');
  expect(workspace.editArtifact(artifact.id, 1, 'Edit 1', 'edit-1')).toEqual(edited);
  expect(workspace.artifact(artifact.id).text).toBe('Edit 2');
  expect(
    store.db
      .prepare('PRAGMA table_info(helper_artifacts)')
      .all()
      .map((r) => r.name)
  ).not.toContain('snapshot');
  expect(
    workspace
      .events(conversation.id)
      .filter((e) => e.kind === 'tool.finished')
      .every((e) => (e.data as { detailsOmitted?: boolean }).detailsOmitted)
  ).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(workspace.events(conversation.id)))).toBeLessThan(6000);
  expect(
    Buffer.byteLength(
      JSON.stringify(store.db.prepare('SELECT result FROM helper_operations').all())
    )
  ).toBeLessThan(1000);
  expect(() => workspace.operation(task.id, 'read-receipt', {}, () => result)).toThrow(
    'HELPER_TASK_NO_LONGER_ACTIVE'
  );
});

test('real prior schema-1 output upgrades with original text, translation and oneoff semantics intact', () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-real-migration-'));
  const db = new DatabaseSync(join(path, 'app.sqlite'));
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(readFileSync(new URL('./fixtures/personal-schema-1.sql', import.meta.url), 'utf8'));
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
  expect(db.prepare('SELECT count(*) AS n FROM helper_delegations').get()?.n).toBe(1);
  const original = db.prepare('SELECT id,text FROM sources ORDER BY id').all();
  const translations = db.prepare('SELECT job_id,result FROM job_results ORDER BY job_id').all();
  db.close();
  const owner = { store: new Store(join(path, 'app.sqlite')), path };
  owned.push(owner);
  const store = owner.store,
    chat = store.chats()[0]!;
  const options = new ChatOptionsStore(store),
    state = options.get(chat.id);
  expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(DATABASE_SCHEMA_VERSION);
  expect(store.db.prepare('SELECT id,text FROM sources ORDER BY id').all()).toEqual(original);
  expect(store.db.prepare('SELECT job_id,result FROM job_results ORDER BY job_id').all()).toEqual(
    translations
  );
  expect(state.fixedValues).toEqual({ tone: 'bold' });
  expect(state.pending.map((p) => p.values)).toEqual([{ tone: 'warm' }]);
  expect(state.pending[0]).not.toHaveProperty('headHash');
  const request = {
    request: 'Continue',
    expectedRevision: chat.headRevision,
    expectedSettingsRevision: chat.settingsRevision,
    branchId: state.branchId,
    idempotencyKey: randomUUID(),
  };
  const run = store.createRun(chat.id, request, (c) => ({
    chatId: c.id,
    parentRevision: c.headRevision,
    settings: c.settings,
    settingsRevision: c.settingsRevision,
    request: request.request,
    history: store.history(c.headRevision),
    resources: [],
    profile: store.product.snapshot(c.id),
  }));
  expect(run.run.snapshot.profile!.chatOptions!.values).toEqual({ tone: 'warm' });
  expect(options.get(chat.id).pending).toEqual([]);
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  store.close();
  owner.store = new Store(join(path, 'app.sqlite'));
  expect(owner.store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(
    DATABASE_SCHEMA_VERSION
  );
});
