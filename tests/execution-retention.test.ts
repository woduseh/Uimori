import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import {
  releaseCompletedJobInputs,
  releaseCompletedRunInputs,
} from '../server/execution-retention.js';
import type { WireRecord } from '../core/transport.js';
import { readerRuns } from '../server/reader.js';
import Fastify from 'fastify';
import { readerRoutes } from '../server/reader-routes.js';
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
    return { owner, store, chat, sources };
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

  test.each([
    { protocol: 'openai-chat-v1', inputScope: 'request' },
    { protocol: 'codex-app-server-v1', inputScope: 'turn' },
  ] as const)(
    'scene display retains the final $inputScope token receipt and lore metadata after body cleanup',
    async ({ protocol, inputScope }) => {
      const { store, chat, sources } = fixture();
      const source = sources.at(-1)!;
      const lore = {
        status: 'complete' as const,
        entries: [
          {
            id: 'lore-a',
            title: '항구',
            via: 'tool-result' as const,
            delivery: 'excerpt' as const,
          },
        ],
      };
      const context: NonNullable<WireRecord['requestContext']> = {
        estimatedInputTokens: 2048,
        inputTokenLimit: 8192,
        estimator: 'model-local-v1',
        tokenizer: 'claude-legacy',
        tokenizerFallback: true,
      };
      const receipt: NonNullable<WireRecord['requestReceipt']> = {
        version: 1,
        model: { modelId: 'synthetic-model', title: '호출 당시 모델', presetId: 'frozen-model' },
        prompt: { id: 'frozen-prompt', revision: 2, title: '호출 당시 프롬프트' },
        persona: { id: 'frozen-persona', revision: 3, title: '호출 당시 페르소나', name: '미라' },
        summary: { status: 'included', coveredSources: 4 },
      };
      const wire: WireRecord = {
        connectionId: 'synthetic-connection',
        protocol,
        role: 'main',
        modelId: 'synthetic-model',
        method: 'POST',
        url: 'http://127.0.0.1:9',
        headers: {},
        body: { text: 'PRIVATE_PROMPT_BODY' },
        bodySha256: 'a'.repeat(64),
        stablePrefixSha256: 'b'.repeat(64),
        requestLore: lore,
        requestContext: context,
        requestReceipt: receipt,
      };
      for (const [inputTokens, outputTokens] of [
        [99, 22],
        [30, 7],
      ]) {
        const id = store.product.startAttempt(chat.id, source.runId, null, wire);
        store.product.finishAttempt(id, {
          status: 'completed',
          text: 'PRIVATE_RESPONSE_BODY',
          toolCalls: [],
          refusal: null,
          error: null,
          opaqueState: null,
          usage: {
            inputTokens,
            outputTokens,
            costUsd: null,
            raw: { prompt_tokens_details: { cached_tokens: 12 } },
            priceRevision: null,
          },
        });
      }
      const advisor = store.product.startAttempt(chat.id, source.runId, null, {
        ...wire,
        agentId: 'advisor',
      });
      store.product.finishAttempt(advisor, {
        status: 'completed',
        text: '',
        toolCalls: [],
        refusal: null,
        error: null,
        opaqueState: null,
        usage: {
          inputTokens: 9999,
          outputTokens: 9999,
          costUsd: null,
          raw: null,
          priceRevision: null,
        },
      });
      releaseCompletedRunInputs(store.db, source.runId);
      const retained = store.product.attempts(chat.id);
      expect(retained[0].request).toMatchObject({
        requestLore: lore,
        requestContext: context,
        requestReceipt: receipt,
        detailsOmitted: true,
      });
      expect(JSON.stringify(retained)).not.toContain('PRIVATE_PROMPT_BODY');
      expect(JSON.stringify(retained)).not.toContain('PRIVATE_RESPONSE_BODY');
      const runs = readerRuns(store, chat.id);
      expect(runs.find((run) => run.id === source.runId)?.sceneUsage).toEqual({
        attemptId: retained[1].id,
        inputTokens: 30,
        outputTokens: 7,
        inputScope,
        context,
        receipt,
      });
      expect(runs.find((run) => run.id === sources[0]!.runId)?.sceneUsage).toBeUndefined();
      const app = Fastify();
      readerRoutes(app, store);
      try {
        const detail = await app.inject(`/api/attempts/${retained[1].id}/scene-detail`);
        expect(detail.statusCode).toBe(200);
        expect(detail.json()).toEqual({
          lore,
          cache: protocol === 'openai-chat-v1' ? { readTokens: 12, writeTokens: null } : null,
        });
        expect(JSON.stringify(detail.json())).not.toContain('PRIVATE_');
        expect((await app.inject(`/api/attempts/${advisor}/scene-detail`)).statusCode).toBe(404);
        const path = `/api/chats/${chat.id}/last-scene-lore`;
        const included = await app.inject(path);
        expect(included.statusCode).toBe(200);
        expect(included.json()).toEqual({
          sourceRevision: source.id,
          attemptId: retained[1].id,
          lore,
        });
        // Missing old metadata must not be filled with another scene's or today's lore.
        store.db
          .prepare('UPDATE chats SET head_revision=? WHERE id=?')
          .run(sources[0]!.id, chat.id);
        expect((await app.inject(path)).json()).toEqual({
          sourceRevision: sources[0]!.id,
          attemptId: null,
          lore: null,
        });
        store.db.prepare('UPDATE chats SET head_revision=NULL WHERE id=?').run(chat.id);
        expect((await app.inject(path)).json()).toEqual({
          sourceRevision: null,
          attemptId: null,
          lore: null,
        });
        // An older attempt stays unknown; no current-library reconstruction path runs.
        store.db
          .prepare('UPDATE attempts SET request=? WHERE id=?')
          .run(JSON.stringify({ protocol }), retained[1].id);
        expect(
          readerRuns(store, chat.id).find((run) => run.id === source.runId)?.sceneUsage?.receipt
        ).toBeNull();
      } finally {
        await app.close();
      }
    }
  );

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
        callId: `read-${i}`,
        denied: false,
        errorKind: null,
        originalResultChars: 262155,
        providedResultChars: 512,
        elapsedMs: 10 + i,
        queueMs: i,
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
    const toolEvents = workspace.events(conversation.id).filter((e) => e.kind === 'tool.finished');
    expect(toolEvents.map((e) => e.data)).toEqual(
      Array.from({ length: 5 }, (_, i) => ({
        name: 'resource.read',
        callId: `read-${i}`,
        denied: false,
        errorKind: null,
        originalResultChars: 262155,
        providedResultChars: 512,
        elapsedMs: 10 + i,
        queueMs: i,
        detailsOmitted: true,
      }))
    );
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
