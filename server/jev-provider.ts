import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { JevProviderStatus } from '../core/jev-provider.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import type { ProviderResult } from '../core/transport.js';
import type { Store } from './store.js';
import type { JevCredentialStore } from './jev-credentials.js';
import { HttpError, fields, number, record, text } from './request-validation.js';
import { executeJevJudgment, JevError, JEV_ENDPOINT, JEV_MODEL } from './jev-judgment.js';
import {
  ProviderConnectionTestStore,
  CONNECTION_TEST_TIMEOUT_MS,
} from './provider-connection-test.js';

const CONNECTION_ID = 'typesafe-judgment';
const input = {
  state: 'The characters are entering a library to look for an old map.',
  questions: {
    relevant: {
      type: 'noul' as const,
      instructions: 'Is information about the library relevant to the current scene?',
    },
  },
};
const inputHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
const noUsage = () => ({ inputTokens: null, outputTokens: null, costUsd: null });

export function jevProviderRoutes(
  app: FastifyInstance,
  store: Store,
  credentials: JevCredentialStore,
  options: {
    signal: AbortSignal;
    track: (work: Promise<void>) => void;
    authenticated: (cookie?: string) => boolean;
  }
) {
  // The shared connection-test routes recover running diagnostics once on server startup.
  const journal = new ProviderConnectionTestStore(store);
  const status = (): JevProviderStatus => {
    const latest = store.db
      .prepare(
        'SELECT body FROM provider_connection_tests WHERE model_id=? ORDER BY rowid DESC LIMIT 1'
      )
      .get(CONNECTION_ID) as { body: string } | undefined;
    return {
      ...credentials.status(),
      modelId: JEV_MODEL,
      endpoint: JEV_ENDPOINT,
      latestTest: latest ? (JSON.parse(latest.body) as ProviderConnectionTest) : null,
    };
  };
  app.get('/api/provider-management/jev', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return status();
  });
  app.put('/api/provider-management/jev', { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = record(request.body);
    fields(body, ['expectedRevision', 'apiKey']);
    if (typeof body.apiKey !== 'string') throw new HttpError(400, 'JEV_KEY_INVALID');
    credentials.update(
      number(body.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER),
      body.apiKey
    );
    return status();
  });
  app.delete('/api/provider-management/jev', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = record(request.body);
    fields(body, ['expectedRevision']);
    credentials.update(
      number(body.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER),
      null
    );
    return status();
  });
  app.post('/api/provider-management/jev/test', async (request, reply) => {
    if (options.signal.aborted) throw new HttpError(503, 'Server stopping');
    const body = record(request.body);
    fields(body, ['expectedRevision', 'idempotencyKey']);
    const revision = number(body.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER);
    const key = text(body.idempotencyKey, 'idempotencyKey', 200);
    const admission = store.transaction(() => {
      const prior = store.db
        .prepare(
          'SELECT id,model_id,model_revision FROM provider_connection_tests WHERE idempotency_key=?'
        )
        .get(key) as { id: string; model_id: string; model_revision: number } | undefined;
      if (prior) {
        if (prior.model_id !== CONNECTION_ID || prior.model_revision !== revision)
          throw new HttpError(409, 'JEV_TEST_KEY_CONFLICT');
        return { view: journal.get(prior.id), created: false };
      }
      const current = credentials.status();
      if (current.revision !== revision) throw new HttpError(409, 'JEV_REVISION_CONFLICT');
      if (!current.configured) throw new HttpError(400, 'JEV_CREDENTIAL_REQUIRED');
      if (
        store.db
          .prepare("SELECT 1 FROM provider_connection_tests WHERE model_id=? AND status='running'")
          .get(CONNECTION_ID)
      )
        throw new HttpError(409, 'JEV_TEST_RUNNING');
      const view: ProviderConnectionTest = {
        id: randomUUID(),
        modelId: CONNECTION_ID,
        modelRevision: revision,
        providerModelId: JEV_MODEL,
        connectionId: CONNECTION_ID,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        status: 'running',
        text: '',
        truncated: false,
        latencyMs: null,
        error: null,
        usage: noUsage(),
      };
      store.db
        .prepare(
          'INSERT INTO provider_connection_tests(id,idempotency_key,model_id,model_revision,status,body) VALUES(?,?,?,?,?,?)'
        )
        .run(view.id, key, CONNECTION_ID, revision, view.status, JSON.stringify(view));
      return { view, created: true };
    });
    if (admission.created) {
      options.track(
        (async () => {
          const started = performance.now();
          let usage: ProviderResult['usage'] | undefined;
          const authorize = () => {
            if (options.signal.aborted) throw new JevError('SERVER_STOPPING');
            if (!options.authenticated(request.headers.cookie))
              throw new JevError('SESSION_NOT_AUTHORIZED');
            if (credentials.status().revision !== revision)
              throw new JevError('JEV_CREDENTIAL_CHANGED');
          };
          try {
            authorize();
            const result = await executeJevJudgment(input, inputHash, 1000, {
              signal: options.signal,
              timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
              credential: () => {
                authorize();
                return credentials.resolve();
              },
              onAttemptStart: () => {
                authorize();
                journal.sent(admission.view.id);
                return admission.view.id;
              },
              onAttemptFinish: (_id, result) => {
                usage = result.usage;
              },
            });
            authorize();
            journal.finish(admission.view.id, {
              status: 'completed',
              text: JSON.stringify({ scores: result.scores }),
              truncated: false,
              latencyMs: Math.round(performance.now() - started),
              error: null,
              usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                costUsd: result.usage.costUsd,
              },
            });
          } catch (error) {
            journal.finish(admission.view.id, {
              status: options.signal.aborted ? 'interrupted' : 'error',
              text: '',
              truncated: false,
              latencyMs: Math.round(performance.now() - started),
              error: options.signal.aborted
                ? 'SERVER_STOPPING'
                : error instanceof JevError
                  ? error.code
                  : 'JEV_EXECUTION_FAILED',
              usage: usage ?? noUsage(),
            });
          }
        })()
      );
    }
    reply.code(202).header('Cache-Control', 'no-store');
    return admission.view;
  });
}
