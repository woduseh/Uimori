import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { releaseCompletedJobInputs } from '../server/execution-retention.js';
import { describe } from 'vitest';

describe('Completed execution payload retention', () => {
  const owned: { store: Store; path: string }[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const item of owned.splice(0)) {
      item.store.close();
      rmSync(item.path, { recursive: true, force: true });
    }
  });

  function fixture() {
    const path = mkdtempSync(join(tmpdir(), 'uimori-retention-'));
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
});
