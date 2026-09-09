import { HttpError, fields, number, record, text } from './request-validation.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Connection, ModelGeneration, ModelPreset } from '../core/product.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import {
  generationFromModel,
  protocolOptionKeys,
  validateModelOptions,
} from '../core/model-capabilities.js';
import { providerRejection } from '../core/provider-rejection.js';
import {
  executeProvider,
  ProviderContractError,
  type ProviderExecutionOptions,
  type ProviderRequest,
  type ProviderResult,
} from '../core/transport.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import type { Store } from './store.js';
import { resolveModelPricing } from '../core/model-pricing.js';
import { estimateCost } from '../core/pricing-estimate.js';

export const CONNECTION_TEST_TIMEOUT_MS = 25_000;
const nullUsage = () => ({ inputTokens: null, outputTokens: null, costUsd: null });
type Target = { model: ModelPreset; connection: Connection; request: ProviderRequest };
type TestRow = { id: string; model_id: string; model_revision: number; body: string };
type TestOptions = Pick<
  ProviderExecutionOptions,
  'approvedOrigins' | 'resolveCredential' | 'executeCodex' | 'vertexRequestTier'
> & {
  signal: AbortSignal;
  track: (work: Promise<void>) => void;
  authenticated: (cookie?: string) => boolean;
};

/**
 * A fixed tiny prompt and one transport call with the preset's own options, so the provider's
 * answer is a verdict on those options. Only output size, cache and tools are trimmed; saved
 * creative controls never enter this request.
 */
export function connectionTestRequest(model: ModelPreset, connection: Connection): ProviderRequest {
  const generation: ModelGeneration = { ...generationFromModel(model), maxOutputTokens: 256 };
  delete generation.thinkingBudgetTokens;
  if (protocolOptionKeys(connection.protocol).includes('cacheMode')) {
    generation.cacheMode = 'disabled';
    delete generation.cacheTtl;
  }
  validateModelOptions(generation, connection.protocol);
  return {
    role: 'main',
    modelId: model.modelId,
    pricingSnapshot: resolveModelPricing(model, connection),
    generation,
    contextBudget: contextBudgetForModel({ ...model, connection }),
    stable: { contract: 'API 연결 테스트 중이니 OK만 답해주세요.', tools: [] },
    input: { task: 'API 연결 테스트 중이니 OK만 답해주세요.', controls: {} },
  };
}

export class ProviderConnectionTestStore {
  constructor(private readonly store: Store) {}
  get(id: string): ProviderConnectionTest {
    const row = this.store.db
      .prepare('SELECT body FROM provider_connection_tests WHERE id=?')
      .get(id) as Pick<TestRow, 'body'> | undefined;
    if (!row) throw new HttpError(404, 'Connection test not found');
    return JSON.parse(row.body) as ProviderConnectionTest;
  }
  create(modelId: string, value: unknown): { view: ProviderConnectionTest; target?: Target } {
    const body = record(value);
    fields(body, ['expectedRevision', 'idempotencyKey']);
    const expectedRevision = number(body.expectedRevision, 'expectedRevision');
    const key = text(body.idempotencyKey, 'idempotencyKey', 200);
    return this.store.transaction(() => {
      const prior = this.store.db
        .prepare(
          'SELECT id,model_id,model_revision FROM provider_connection_tests WHERE idempotency_key=?'
        )
        .get(key) as TestRow | undefined;
      if (prior) {
        if (prior.model_id !== modelId || prior.model_revision !== expectedRevision)
          throw new HttpError(409, 'Connection test key reused with different model or revision');
        return { view: this.get(prior.id) };
      }
      const model = this.store.product.get<ModelPreset>('model', modelId);
      if (model.revision !== expectedRevision) throw new HttpError(409, 'Model revision conflict');
      if (model.enabled === false) throw new HttpError(403, 'Connection test model disabled');
      const connection = this.store.product.get<Connection>('connection', model.connectionId);
      this.store.product.authorize(connection);
      if (
        this.store.db
          .prepare("SELECT 1 FROM provider_connection_tests WHERE model_id=? AND status='running'")
          .get(modelId)
      )
        throw new HttpError(409, 'Connection test already running for this model');
      let request: ProviderRequest;
      try {
        request = connectionTestRequest(model, connection);
      } catch (error) {
        throw new HttpError(
          400,
          error instanceof ProviderContractError ? error.code : 'Invalid connection test model'
        );
      }
      const view: ProviderConnectionTest = {
        id: randomUUID(),
        modelId,
        modelRevision: model.revision,
        providerModelId: model.modelId,
        connectionId: connection.id,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        status: 'running',
        text: '',
        truncated: false,
        latencyMs: null,
        error: null,
        usage: nullUsage(),
      };
      this.store.db
        .prepare(
          'INSERT INTO provider_connection_tests(id,idempotency_key,model_id,model_revision,status,body) VALUES(?,?,?,?,?,?)'
        )
        .run(view.id, key, modelId, model.revision, view.status, JSON.stringify(view));
      return { view, target: { model, connection, request } };
    });
  }
  sent(id: string) {
    // Persist the boundary before sending. A second transport send is prohibited even within one executor.
    const change = this.store.db
      .prepare(
        "UPDATE provider_connection_tests SET sent_at=? WHERE id=? AND status='running' AND sent_at IS NULL"
      )
      .run(new Date().toISOString(), id);
    if (Number(change.changes) !== 1)
      throw new ProviderContractError('CONNECTION_TEST_DUPLICATE_SEND');
  }
  finish(
    id: string,
    result: Pick<
      ProviderConnectionTest,
      | 'status'
      | 'text'
      | 'truncated'
      | 'latencyMs'
      | 'error'
      | 'usage'
      | 'rejection'
      | 'estimatedCost'
    >
  ) {
    const current = this.get(id);
    if (current.status !== 'running') return;
    const view: ProviderConnectionTest = {
      ...current,
      ...result,
      finishedAt: new Date().toISOString(),
    };
    this.store.db
      .prepare(
        "UPDATE provider_connection_tests SET status=?,body=? WHERE id=? AND status='running'"
      )
      .run(view.status, JSON.stringify(view), id);
  }
  recover() {
    for (const row of this.store.db
      .prepare("SELECT id FROM provider_connection_tests WHERE status='running'")
      .all() as { id: string }[]) {
      this.finish(row.id, {
        status: 'interrupted',
        text: '',
        truncated: false,
        latencyMs: null,
        error: 'SERVER_RESTARTED',
        usage: nullUsage(),
      });
    }
  }
}

function safeCode(code: string | undefined): string | null {
  return code && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? code : code ? 'PROVIDER_ERROR' : null;
}

export function providerConnectionTestRoutes(
  app: FastifyInstance,
  store: Store,
  options: TestOptions
) {
  const journal = new ProviderConnectionTestStore(store);
  journal.recover();
  app.post<{ Params: { id: string } }>(
    '/api/provider-management/models/:id/test',
    async (request, reply) => {
      if (options.signal.aborted) throw new HttpError(503, 'Server stopping');
      const admission = journal.create(request.params.id, request.body);
      if (admission.target) {
        const { model, connection, request: input } = admission.target;
        const id = admission.view.id;
        options.track(
          (async () => {
            const started = performance.now();
            const timeout = AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS);
            const signal = AbortSignal.any([options.signal, timeout]);
            let result: ProviderResult | undefined;
            let boundaryError: string | undefined;
            const authorize = () => {
              if (signal.aborted)
                throw new ProviderContractError(
                  options.signal.aborted ? 'SERVER_STOPPING' : 'TIMEOUT'
                );
              if (!options.authenticated(request.headers.cookie))
                throw new ProviderContractError('SESSION_NOT_AUTHORIZED');
              const current = store.product.get<ModelPreset>('model', model.id);
              if (current.enabled === false || current.revision !== model.revision)
                throw new ProviderContractError('CONNECTION_TEST_MODEL_CHANGED');
              try {
                store.product.authorize(connection);
              } catch {
                throw new ProviderContractError('CONNECTION_NOT_AUTHORIZED');
              }
            };
            try {
              authorize();
              result = await executeProvider(
                {
                  id: connection.id,
                  protocol: connection.protocol,
                  endpoint: connection.endpoint,
                  ...(connection.credentialEnv ? { credentialEnv: connection.credentialEnv } : {}),
                },
                input,
                {
                  approvedOrigins: options.approvedOrigins,
                  signal,
                  timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
                  vertexRequestTier: options.vertexRequestTier,
                  resolveCredential: options.resolveCredential,
                  executeCodex: options.executeCodex,
                  beforeTurn: authorize,
                  onWire: () => {
                    try {
                      authorize();
                      journal.sent(id);
                      authorize();
                    } catch (error) {
                      boundaryError =
                        error instanceof ProviderContractError
                          ? error.code
                          : 'CONNECTION_TEST_RECORD_FAILED';
                      throw error;
                    }
                  },
                }
              );
              if (boundaryError) throw new ProviderContractError(boundaryError);
              authorize();
              const output = result.text || result.refusal || '';
              const rejection = providerRejection(result.error?.diagnostic);
              journal.finish(id, {
                estimatedCost: estimateCost(
                  input.pricingSnapshot,
                  result.usage,
                  admission.view.createdAt
                ),
                ...(rejection ? { rejection } : {}),
                status:
                  result.status === 'tool_calls'
                    ? 'error'
                    : result.status === 'completed' && !output.trim()
                      ? 'error'
                      : result.status,
                text: output.slice(0, 2000),
                truncated: output.length > 2000,
                latencyMs: Math.round(performance.now() - started),
                error:
                  result.status === 'tool_calls'
                    ? 'CONNECTION_TEST_UNEXPECTED_TOOL'
                    : result.status === 'completed' && !output.trim()
                      ? 'CONNECTION_TEST_EMPTY_RESPONSE'
                      : safeCode(result.error?.code),
                usage: {
                  inputTokens: result.usage.inputTokens,
                  outputTokens: result.usage.outputTokens,
                  costUsd: result.usage.costUsd,
                },
              });
            } catch (error) {
              const code = options.signal.aborted
                ? 'SERVER_STOPPING'
                : timeout.aborted
                  ? 'TIMEOUT'
                  : error instanceof ProviderContractError
                    ? safeCode(error.code)
                    : 'CONNECTION_TEST_FAILED';
              journal.finish(id, {
                status: options.signal.aborted
                  ? 'interrupted'
                  : timeout.aborted && result?.text
                    ? 'partial'
                    : 'error',
                text: timeout.aborted ? (result?.text.slice(0, 2000) ?? '') : '',
                truncated: timeout.aborted && (result?.text.length ?? 0) > 2000,
                latencyMs: Math.round(performance.now() - started),
                error: code,
                usage: result
                  ? {
                      inputTokens: result.usage.inputTokens,
                      outputTokens: result.usage.outputTokens,
                      costUsd: result.usage.costUsd,
                    }
                  : nullUsage(),
              });
            }
          })()
        );
      }
      reply.code(202).header('Cache-Control', 'no-store');
      return admission.view;
    }
  );
  app.get<{ Params: { id: string } }>(
    '/api/provider-management/tests/:id',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return journal.get(request.params.id);
    }
  );
}
