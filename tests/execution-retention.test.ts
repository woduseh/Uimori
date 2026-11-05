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
import { recordToolDiagnostic, startToolDiagnostic } from '../server/execution-diagnostics.js';
import { deleteChat } from '../server/chat-deletion.js';

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

  test('completed runs retain bounded tool and attempt metadata while clearing their replay bodies', () => {
    const { store, chat, sources } = fixture();
    const runId = sources[0]!.runId;
    const event = {
      callId: 'read-call',
      name: 'knowledge.read',
      args: { ids: ['reference'], offset: 17, password: 'PRIVATE_CREDENTIAL' },
      result: { text: 'PRIVATE_TOOL_OUTPUT' },
      denied: false,
    };
    store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(runId);
    startToolDiagnostic(store.db, { kind: 'run', id: runId, origin: 'writer' }, event);
    store.tool(runId, event, { elapsedMs: 13, originalResultChars: 100 });
    startToolDiagnostic(
      store.db,
      { kind: 'run', id: runId, origin: 'writer' },
      {
        callId: 'unfinished',
        name: 'data.exec',
        args: { command: 'echo unfinished' },
      }
    );
    store.tool(
      runId,
      {
        callId: 'submit-call',
        name: 'story.submit',
        args: {},
        result: { accepted: true },
        denied: false,
      },
      { elapsedMs: 3, diagnosticArgs: { content: 'PRIVATE_AUTHORED_BODY' } }
    );
    store.tool(
      runId,
      {
        callId: 'shell-limited',
        name: 'data.exec',
        args: { command: 'echo test' },
        denied: true,
        errorKind: 'recoverable',
        result: {
          code: 'TOOL_CONTEXT_LIMIT_EXCEEDED',
          returned: false,
          execution: { exitCode: 2, timedOut: false, outputBytes: 5000, truncated: true },
        },
      },
      { elapsedMs: 8, originalResultChars: 5100 }
    );
    const wire: WireRecord = {
      connectionId: 'fixture',
      protocol: 'openai-chat-v1',
      role: 'main',
      modelId: 'fixture',
      method: 'POST',
      url: 'http://127.0.0.1:9',
      headers: {},
      body: { text: 'PRIVATE_PROMPT' },
      bodySha256: 'x',
      stablePrefixSha256: 'y',
    };
    const attempt = store.product.startAttempt(chat.id, runId, null, wire);
    store.db
      .prepare('UPDATE attempts SET started_at=? WHERE id=?')
      .run('2026-01-01T00:00:00.000Z', attempt);
    store.product.finishAttempt(attempt, {
      status: 'completed',
      text: 'PRIVATE_PROVIDER_OUTPUT',
      toolCalls: [],
      refusal: null,
      error: null,
      opaqueState: null,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: null, raw: null, priceRevision: null },
    });
    store.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(runId);
    releaseCompletedRunInputs(store.db, runId);
    expect(store.db.prepare('SELECT * FROM tool_events WHERE run_id=?').all(runId)).toEqual([]);
    const entries = store.db
      .prepare('SELECT data FROM execution_tool_diagnostics WHERE run_id=? ORDER BY seq')
      .all(runId)
      .map((row) => JSON.parse(String(row.data)));
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({
      state: 'finished',
      name: 'knowledge.read',
      denied: false,
      elapsedMs: 13,
      originalResultChars: 100,
      providedResultChars: JSON.stringify(event.result).length,
    });
    expect(entries[0].argsPreview).toContain('17');
    expect(entries[1]).toMatchObject({ state: 'started', effect: 'unknown', name: 'data.exec' });
    expect(entries[2]).toMatchObject({
      name: 'story.submit',
      argsPreview: '[authored submission withheld]',
      argsRedacted: true,
    });
    expect(entries[3]).toMatchObject({
      errorCode: 'TOOL_CONTEXT_LIMIT_EXCEEDED',
      originalResultChars: 5100,
      shell: { exitCode: 2, timedOut: false, outputBytes: 5000, truncated: true },
    });
    const saved = store.db.prepare('SELECT response FROM attempts WHERE id=?').get(attempt)!;
    const response = JSON.parse(String(saved.response));
    expect(response.executionDiagnostic).toMatchObject({
      finishedAt: expect.any(String),
      elapsedMs: expect.any(Number),
    });
    expect(response.executionDiagnostic.elapsedMs).toBeGreaterThan(0);
    const retained = JSON.stringify({ entries, response });
    for (const secret of [
      'PRIVATE_CREDENTIAL',
      'PRIVATE_TOOL_OUTPUT',
      'PRIVATE_AUTHORED_BODY',
      'PRIVATE_PROMPT',
      'PRIVATE_PROVIDER_OUTPUT',
    ])
      expect(retained).not.toContain(secret);
    // A duplicate terminal callback never overwrites the first outcome or its measured time.
    store.product.finishAttempt(attempt, {
      status: 'error',
      text: '',
      toolCalls: [],
      refusal: null,
      error: { code: 'LATE' },
      opaqueState: null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        raw: null,
        priceRevision: null,
      },
    });
    expect(
      JSON.parse(
        String(store.db.prepare('SELECT response FROM attempts WHERE id=?').get(attempt)!.response)
      )
    ).toEqual(response);
  });

  test('job and illustration diagnostics respect active ownership and cascade with chat deletion', () => {
    const { store, chat, sources } = fixture();
    const jobId = String(
      store.db
        .prepare("SELECT id FROM jobs WHERE source_revision=? AND kind='translation'")
        .get(sources[0]!.id)!.id
    );
    const illustrationId = randomUUID();
    const timestamp = new Date().toISOString();
    store.db
      .prepare("UPDATE jobs SET status='running',generation=2,owner='owner' WHERE id=?")
      .run(jobId);
    store.db
      .prepare(`INSERT INTO illustration_jobs(id,chat_id,source_revision,source_hash,origin,status,generation,owner,input,created_at,updated_at)
      VALUES(?,?,?,?,'manual','running',4,'owner','{}',?,?)`)
      .run(illustrationId, chat.id, sources[0]!.id, sources[0]!.hash, timestamp, timestamp);
    const event = {
      callId: 'call',
      name: 'knowledge.read',
      args: { ids: ['reference'] },
      result: { text: 'PRIVATE_REFERENCE' },
      denied: false,
    };
    for (const owner of [
      {
        kind: 'job' as const,
        id: jobId,
        generation: 1,
        owner: 'owner',
        origin: 'translation' as const,
      },
      {
        kind: 'job' as const,
        id: jobId,
        generation: 2,
        owner: 'other',
        origin: 'translation' as const,
      },
      {
        kind: 'illustration' as const,
        id: illustrationId,
        generation: 3,
        owner: 'owner',
        origin: 'illustration' as const,
      },
      {
        kind: 'illustration' as const,
        id: illustrationId,
        generation: 4,
        owner: 'other',
        origin: 'illustration' as const,
      },
    ])
      recordToolDiagnostic(store.db, owner, event);
    startToolDiagnostic(
      store.db,
      { kind: 'job', id: jobId, generation: 1, owner: 'owner', origin: 'translation' },
      event
    );
    startToolDiagnostic(
      store.db,
      {
        kind: 'illustration',
        id: illustrationId,
        generation: 4,
        owner: 'other',
        origin: 'illustration',
      },
      event
    );
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM execution_tool_diagnostics').get()!.n).toBe(
      0
    );
    startToolDiagnostic(
      store.db,
      { kind: 'job', id: jobId, generation: 2, owner: 'owner', origin: 'translation' },
      event
    );
    startToolDiagnostic(
      store.db,
      {
        kind: 'illustration',
        id: illustrationId,
        generation: 4,
        owner: 'owner',
        origin: 'illustration',
      },
      event
    );
    // Late completion belongs to the observed start even when cancellation changed ownership.
    store.db.prepare("UPDATE jobs SET status='cancelled',owner=NULL WHERE id=?").run(jobId);
    store.db
      .prepare("UPDATE illustration_jobs SET status='cancelled',owner=NULL WHERE id=?")
      .run(illustrationId);
    recordToolDiagnostic(
      store.db,
      { kind: 'job', id: jobId, generation: 2, owner: 'owner', origin: 'translation' },
      event,
      { elapsedMs: 2 }
    );
    recordToolDiagnostic(
      store.db,
      {
        kind: 'illustration',
        id: illustrationId,
        generation: 4,
        owner: 'owner',
        origin: 'illustration',
      },
      event,
      { elapsedMs: 3 }
    );
    store.db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(jobId);
    store.db
      .prepare("UPDATE illustration_jobs SET status='completed' WHERE id=?")
      .run(illustrationId);
    releaseCompletedJobInputs(store.db, jobId);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM execution_tool_diagnostics').get()!.n).toBe(
      2
    );
    expect(
      JSON.stringify(store.db.prepare('SELECT data FROM execution_tool_diagnostics').all())
    ).not.toContain('PRIVATE_REFERENCE');
    deleteChat(store, chat.id, {});
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM execution_tool_diagnostics').get()!.n).toBe(
      0
    );
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
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

  test('completed auxiliary cleanup retains a content-free preflight purpose', () => {
    const { store, chat, sources } = fixture();
    const jobId = String(
      store.db
        .prepare("SELECT id FROM jobs WHERE source_revision=? AND kind='translation'")
        .get(sources[0]!.id)!.id
    );
    const attempt = store.product.startAttempt(
      chat.id,
      null,
      jobId,
      {
        connectionId: 'typesafe-judgment',
        protocol: 'typesafe-systemone-v1',
        role: 'translation',
        modelId: 'jev',
        method: 'POST',
        url: 'https://example.invalid',
        headers: {},
        body: { text: 'PRIVATE_PREFLIGHT_TEXT' },
        bodySha256: 'x',
        stablePrefixSha256: 'y',
        judgment: { kind: 'codex-content-preflight', inputHash: 'private-hash' },
      },
      { kind: 'judgment', retainContent: false }
    );
    store.product.finishAttempt(attempt, {
      status: 'error',
      text: '',
      toolCalls: [],
      refusal: null,
      error: { code: 'JEV_EXECUTION_FAILED' },
      opaqueState: null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        raw: null,
        priceRevision: null,
      },
    });
    releaseCompletedJobInputs(store.db, jobId);
    const row = store.db
      .prepare('SELECT request,response,error FROM attempts WHERE id=?')
      .get(attempt)!;
    expect(row.error).toBe('JEV_EXECUTION_FAILED');
    expect(JSON.parse(String(row.response))).toMatchObject({
      executionDiagnostic: { purpose: 'codex-content-preflight', finishedAt: expect.any(String) },
    });
    expect(JSON.stringify(row)).not.toContain('PRIVATE_PREFLIGHT_TEXT');
    expect(JSON.stringify(row)).not.toContain('private-hash');
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
        limits: { totalCalls: 4, helperCalls: 4 },
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
      limits: { totalCalls: 8, helperCalls: 8 },
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
    const artifact = { id: randomUUID(), revision: 1 };
    const insertArtifact = store.db.prepare(
      'INSERT INTO helper_artifacts VALUES(?,?,?,?,?,?,?,?,?)'
    );
    for (const [index, text] of ['A short draft.', 'Edit 1', 'Edit 2'].entries())
      insertArtifact.run(
        artifact.id,
        index + 1,
        conversation.id,
        task.id,
        'Draft',
        text,
        JSON.stringify(usage),
        new Date().toISOString(),
        index ? 'edit' : 'model'
      );
    workspace.finish(task.id, 'owner', 1, 'completed', 'Done', null);
    store.db
      .prepare("UPDATE helper_messages SET artifacts=? WHERE task_id=? AND role='assistant'")
      .run(JSON.stringify([artifact]), task.id);
    expect(workspace.artifact(artifact.id, 1).text).toBe('A short draft.');
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
        status: null,
        callId: `read-${i}`,
        finishedAt: null,
        errorCode: null,
        shell: null,
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
