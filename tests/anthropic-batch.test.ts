import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { AnthropicBatchRun, recoverableAnthropicBatchRun } from '../server/anthropic-batch.js';
import type { Store } from '../server/store.js';
import type {
  ProviderConnection,
  ProviderExecutionOptions,
  ProviderRequest,
  WireRecord,
} from '../core/transport.js';
import { loopbackProvider } from './fixtures/loopback-provider.js';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE runs(id TEXT PRIMARY KEY);
    CREATE TABLE attempts(id TEXT PRIMARY KEY,run_id TEXT,status TEXT,request TEXT);
    CREATE TABLE anthropic_batches(
      attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
      run_id TEXT NOT NULL REFERENCES runs(id),
      ordinal INTEGER NOT NULL,
      batch_id TEXT UNIQUE,
      custom_id TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(run_id,ordinal)
    );
    INSERT INTO runs VALUES('run-1');
  `);
  return db;
}

const connection = (endpoint: string): ProviderConnection => ({
  id: 'anthropic',
  protocol: 'anthropic-messages-v1',
  endpoint,
  credentialRef: 'ANTHROPIC_TEST_KEY',
});

const request = (): ProviderRequest => ({
  role: 'main',
  modelId: 'claude-opus-5',
  stable: { contract: 'Write the requested prose.', tools: [] },
  generation: { maxOutputTokens: 2048, temperature: null },
  input: { task: 'Continue the scene.', controls: {} },
});

function options(
  db: DatabaseSync,
  signal: AbortSignal,
  onResume?: (attemptId: string) => void,
  cancelRemoteOnAbort = false
): ProviderExecutionOptions {
  return {
    signal,
    resolveCredential: () => 'synthetic-anthropic-key',
    cancelRemoteOnAbort: () => cancelRemoteOnAbort,
    onWire: (wire: WireRecord, resumeAttemptId?: string) => {
      if (resumeAttemptId) {
        onResume?.(resumeAttemptId);
        return resumeAttemptId;
      }
      const id = 'attempt-1';
      db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run(
        id,
        'run-1',
        'running',
        JSON.stringify(wire)
      );
      return id;
    },
  };
}

function json(response: import('node:http').ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('fixture condition did not settle');
}

describe('Anthropic Batch execution', () => {
  test('restarts from the durable batch id without creating a second paid request', async () => {
    let ended = false;
    const server = await loopbackProvider(async (captured, response) => {
      if (captured.url === '/v1/messages/batches') {
        const body = JSON.parse(captured.body);
        expect(body.requests).toHaveLength(1);
        expect(body.requests[0].custom_id).toBe('attempt-1');
        expect(body.requests[0].params).not.toHaveProperty('stream');
        json(response, { id: 'batch-1', processing_status: 'in_progress' });
        return;
      }
      if (captured.url === '/v1/messages/batches/batch-1') {
        json(response, {
          id: 'batch-1',
          processing_status: ended ? 'ended' : 'in_progress',
        });
        return;
      }
      if (captured.url === '/v1/messages/batches/batch-1/results') {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(
          JSON.stringify({
            custom_id: 'attempt-1',
            result: {
              type: 'succeeded',
              message: {
                id: 'msg-batch-1',
                type: 'message',
                role: 'assistant',
                model: 'claude-opus-5',
                content: [{ type: 'text', text: 'Recovered Batch prose.' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 11, output_tokens: 6 },
              },
            },
          }) + '\n'
        );
        return;
      }
      throw new Error(`unexpected fixture request: ${captured.url}`);
    });
    closes.push(server.close);

    const db = database();
    const store = { db } as Store;
    const controller = new AbortController();
    const first = new AnthropicBatchRun(store, 'run-1', 5).execute(
      connection(`${server.origin}/v1`),
      request(),
      options(db, controller.signal)
    );
    await until(
      () =>
        db.prepare('SELECT batch_id FROM anthropic_batches WHERE run_id=?').get('run-1')
          ?.batch_id === 'batch-1'
    );
    controller.abort(new Error('Server stopping'));
    expect(await first).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(recoverableAnthropicBatchRun(store, 'run-1')).toBe(true);

    ended = true;
    let resumed = '';
    const second = await new AnthropicBatchRun(store, 'run-1', 1).execute(
      connection(`${server.origin}/v1`),
      request(),
      options(db, new AbortController().signal, (id) => {
        resumed = id;
      })
    );
    expect(resumed).toBe('attempt-1');
    expect(second).toMatchObject({
      status: 'completed',
      text: 'Recovered Batch prose.',
      usage: { inputTokens: 11, outputTokens: 6 },
    });
    expect(
      server.requests.filter(
        (item) => item.url === '/v1/messages/batches' && JSON.parse(item.body).requests
      )
    ).toHaveLength(1);
    expect(
      JSON.parse(
        String(
          db.prepare('SELECT result FROM anthropic_batches WHERE run_id=?').get('run-1')?.result
        )
      )
    ).toMatchObject({ custom_id: 'attempt-1', result: { type: 'succeeded' } });
    db.close();
  });

  test('explicit local cancellation requests remote Batch cancellation best-effort', async () => {
    let cancelled = 0;
    const server = await loopbackProvider(async (captured, response) => {
      if (captured.url === '/v1/messages/batches') {
        json(response, { id: 'batch-cancel', processing_status: 'in_progress' });
        return;
      }
      if (captured.url === '/v1/messages/batches/batch-cancel') {
        json(response, { id: 'batch-cancel', processing_status: 'in_progress' });
        return;
      }
      if (captured.url === '/v1/messages/batches/batch-cancel/cancel') {
        cancelled++;
        json(response, { id: 'batch-cancel', processing_status: 'canceling' });
        return;
      }
      throw new Error(`unexpected fixture request: ${captured.url}`);
    });
    closes.push(server.close);
    const db = database();
    const controller = new AbortController();
    const running = new AnthropicBatchRun({ db } as Store, 'run-1', 5).execute(
      connection(`${server.origin}/v1`),
      request(),
      options(db, controller.signal, undefined, true)
    );
    await until(
      () =>
        db.prepare('SELECT batch_id FROM anthropic_batches WHERE run_id=?').get('run-1')
          ?.batch_id === 'batch-cancel'
    );
    controller.abort(new Error('Run cancelled'));
    expect(await running).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(cancelled).toBe(1);
    db.close();
  });

  test('a reserved pre-submit row safely creates the Batch after restart', async () => {
    const server = await loopbackProvider(async (captured, response) => {
      if (captured.url === '/v1/messages/batches') {
        json(response, { id: 'batch-reserved', processing_status: 'ended' });
        return;
      }
      if (captured.url === '/v1/messages/batches/batch-reserved/results') {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(
          JSON.stringify({
            custom_id: 'attempt-1',
            result: {
              type: 'succeeded',
              message: {
                id: 'msg-reserved',
                type: 'message',
                role: 'assistant',
                model: 'claude-opus-5',
                content: [{ type: 'text', text: 'Reserved restart completed.' }],
                stop_reason: 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 8, output_tokens: 4 },
              },
            },
          }) + '\n'
        );
        return;
      }
      throw new Error(`unexpected fixture request: ${captured.url}`);
    });
    closes.push(server.close);
    const db = database();
    const crashed = await new AnthropicBatchRun({ db } as Store, 'run-1', 1).execute(
      connection(`${server.origin}/v1`),
      request(),
      {
        signal: new AbortController().signal,
        resolveCredential: () => 'synthetic-anthropic-key',
        onWire: (wire) => {
          const time = new Date().toISOString();
          db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run(
            'attempt-1',
            'run-1',
            'running',
            JSON.stringify(wire)
          );
          db.prepare(
            `INSERT INTO anthropic_batches VALUES(
              'attempt-1','run-1',0,NULL,'attempt-1',?,'reserved',NULL,?,?
            )`
          ).run(wire.bodySha256, time, time);
          throw new Error('synthetic crash after local reservation');
        },
      }
    );
    expect(crashed.status).toBe('error');
    expect(server.requests).toHaveLength(0);
    expect(
      db.prepare('SELECT status FROM anthropic_batches WHERE run_id=?').get('run-1')?.status
    ).toBe('reserved');

    const result = await new AnthropicBatchRun({ db } as Store, 'run-1', 1).execute(
      connection(`${server.origin}/v1`),
      request(),
      options(db, new AbortController().signal, (id) => expect(id).toBe('attempt-1'))
    );
    expect(result).toMatchObject({ status: 'completed', text: 'Reserved restart completed.' });
    expect(server.requests.filter((item) => item.url === '/v1/messages/batches')).toHaveLength(1);
    db.close();
  });

  test('never resubmits an acknowledgement-uncertain create', async () => {
    const server = await loopbackProvider(async (captured, _response) => {
      throw new Error(`unexpected remote call after uncertain create: ${captured.url}`);
    });
    closes.push(server.close);
    const db = database();
    const firstController = new AbortController();
    firstController.abort(new Error('synthetic setup'));
    const setup = await new AnthropicBatchRun({ db } as Store, 'run-1', 1).execute(
      connection(`${server.origin}/v1`),
      request(),
      options(db, firstController.signal)
    );
    expect(setup.status).toBe('cancelled');
    expect(
      db.prepare('SELECT status FROM anthropic_batches WHERE run_id=?').get('run-1')?.status
    ).toBe('creating');

    const result = await new AnthropicBatchRun({ db } as Store, 'run-1', 1).execute(
      connection(`${server.origin}/v1`),
      request(),
      options(db, new AbortController().signal, (id) => expect(id).toBe('attempt-1'))
    );
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'ANTHROPIC_BATCH_CREATE_UNCERTAIN' },
    });
    expect(server.requests).toHaveLength(0);
    db.close();
  });
});
