import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp, type App } from '../server/app.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import * as transport from '../core/transport.js';

const owned: { app: App; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of owned.splice(0)) {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-save-receipts-'));
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'helper-save-receipts',
    testMode: true,
    codex: { enabled: false },
  });
  owned.push({ app, directory });
  const store = app.store;
  const connection = store.product.connection({
    title: 'Synthetic receipt provider',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic receipt model',
    connectionId: connection.id,
    modelId: 'synthetic-receipt',
    temperature: null,
    maxOutputTokens: 1024,
    inputTokenLimit: 272000,
  });
  const selected = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: selected.revision,
    routes: { ...selected.routes, main: { id: model.id } },
    translationPolicy: selected.translationPolicy,
    helperModel: { id: model.id },
    contextModel: { id: model.id },
  });
  const chat = createFixtureChat(store, 'Receipt save target');
  for (let i = 0; i < 3; i++) completedSource(store, chat.id, 'Synthetic scene ' + i);
  const workspace = new HelperWorkspace(store);
  const conversation = workspace.open({ kind: 'chat', chatId: chat.id });
  const submit = async (retryOf?: string) => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/helper/conversations/${conversation.id}/messages`,
      payload: {
        requestKey: retryOf ? 'retry-save' : 'save',
        text: 'Save the requested app change.',
        ...(retryOf ? { retryOf } : {}),
      },
    });
    return response;
  };
  const run = async () => {
    const response = await submit();
    expect(response.statusCode, response.body).toBe(200);
    const taskId = response.json().id as string;
    for (let i = 0; i < 500 && ['queued', 'running'].includes(workspace.task(taskId).status); i++)
      await delay(10);
    return workspace.task(taskId);
  };
  return { app, store, workspace, conversation, chat, submit, run };
}

const success: transport.ProviderResult = {
  status: 'completed',
  text: 'Synthetic context summary.',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 10, outputTokens: 5, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};
// Intercept only the paid provider. App routing, context preparation and saves stay real.
function provider(name: string, args: Record<string, transport.Json>, beforeSummary?: () => void) {
  let helperCalls = 0;
  return vi
    .spyOn(transport, 'executeProvider')
    .mockImplementation(async (connection, request, options) => {
      transport.validateConnection(connection);
      options.beforeTurn?.();
      await options.onWire?.({
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'POST',
        url: connection.endpoint,
        headers: {},
        body: request as unknown as transport.Json,
        bodySha256: 'synthetic',
        stablePrefixSha256: 'synthetic',
      });
      if (request.role !== 'helper') {
        beforeSummary?.();
        return structuredClone(success);
      }
      if (helperCalls++ === 0)
        return {
          ...structuredClone(success),
          status: 'tool_calls',
          text: '',
          toolCalls: [{ id: 'save-once', name: 'app.call', arguments: { name, arguments: args } }],
        };
      return {
        ...structuredClone(success),
        status: 'error',
        text: '',
        error: { code: 'SYNTHETIC_RESPONSE_LOST' },
      };
    });
}

test.each(['notes.write', 'context.edit', 'context.compact'] as const)(
  '%s stays committed and blocks whole-task replay after a later provider failure',
  async (name) => {
    const f = await fixture();
    const args: Record<string, transport.Json> =
      name === 'notes.write'
        ? { body: { expectedRevision: 0, text: 'Saved author note.' } }
        : name === 'context.edit'
          ? { expectedRevision: 0, summary: 'Saved explicit context summary.' }
          : { expectedRevision: 0 };
    provider(name, args);
    const task = await f.run();
    expect(task).toMatchObject({ status: 'failed', completedEffects: { count: 1 } });
    expect(
      f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
        ?.n
    ).toBe(1);
    if (name === 'notes.write') {
      expect(
        f.store.story.notes.entries({
          chatId: f.chat.id,
          history: f.store.history(f.store.chat(f.chat.id).headRevision),
        })
      ).toEqual([expect.objectContaining({ text: 'Saved author note.' })]);
    } else {
      expect(f.store.context.current(f.chat.id).checkpoint?.plan.summary).toBe(
        name === 'context.edit' ? 'Saved explicit context summary.' : 'Synthetic context summary.'
      );
      if (name === 'context.compact')
        expect(
          f.store.db.prepare('SELECT status FROM context_jobs WHERE chat_id=?').get(f.chat.id)
            ?.status
        ).toBe('completed');
    }
    const retry = await f.submit(task.id);
    expect(retry.statusCode).toBe(409);
    expect(retry.body).toContain('HELPER_EFFECTS_ALREADY_COMMITTED');
  }
);

test('a failed helper receipt rolls back the note and its owner receipt together', async () => {
  const f = await fixture();
  f.store.db.exec(`CREATE TEMP TRIGGER reject_helper_receipt BEFORE INSERT ON helper_operations
    BEGIN SELECT RAISE(ABORT, 'RECEIPT_FAIL'); END`);
  const send = provider('notes.write', { body: { expectedRevision: 0, text: 'Must roll back.' } });
  const task = await f.run();
  expect(task).toMatchObject({ status: 'failed', error: 'RECEIPT_FAIL' });
  expect(task.completedEffects?.count ?? 0).toBe(0);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM author_notes').get()?.n).toBe(0);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM author_note_commands').get()?.n).toBe(0);
  expect(f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations').get()?.n).toBe(0);
  expect(send).toHaveBeenCalledTimes(1);
});

test('a context job cancelled before finish never receives a successful helper receipt', async () => {
  const f = await fixture();
  let cancelled = false;
  provider('context.compact', { expectedRevision: 0 }, () => {
    const job = f.store.db
      .prepare("SELECT id FROM context_jobs WHERE chat_id=? AND status='running'")
      .get(f.chat.id);
    expect(job).toBeDefined();
    f.store.context.cancel(f.chat.id, String(job!.id));
    cancelled = true;
  });
  const task = await f.run();
  expect(cancelled).toBe(true);
  expect(task.status).toBe('failed');
  expect(task.completedEffects?.count ?? 0).toBe(0);
  expect(
    f.store.db.prepare('SELECT COUNT(*) AS n FROM helper_operations WHERE task_id=?').get(task.id)
      ?.n
  ).toBe(0);
  expect(
    f.store.db.prepare('SELECT status FROM context_jobs WHERE chat_id=?').get(f.chat.id)?.status
  ).toBe('cancelled');
  expect(f.store.context.current(f.chat.id).checkpoint).toBeNull();
  expect(
    f.workspace.events(f.conversation.id).find((event) => event.kind === 'tool.finished')?.data
  ).toMatchObject({
    denied: true,
    result: { outcome: 'unchanged', error: 'CONTEXT_JOB_NOT_RUNNING' },
  });
});
