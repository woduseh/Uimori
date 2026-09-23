import { createHash } from 'node:crypto';
import {
  AnthropicProtocolError,
  decodeAnthropicMessage,
  diagnosticAnthropicBody,
  encodeAnthropic,
} from '../core/anthropic-protocol.js';
import { assertContextBudget } from '../core/context-budget.js';
import {
  readProviderHttpDiagnostic,
  type ProviderHttpDiagnostic,
} from '../core/provider-http-error.js';
import { providerFetchOptions, transportFailureCode } from '../core/provider-fetch.js';
import { ProviderContractError } from '../core/provider-errors.js';
import { validateProviderEndpoint } from '../core/product.js';
import { validateConnection, validateRequest } from '../core/provider-request.js';
import type {
  Json,
  ProviderConnection,
  ProviderExecutionOptions,
  ProviderRequest,
  ProviderResult,
  WireRecord,
} from '../core/transport.js';
import type { Store } from './store.js';

type Row = Record<string, any>;
type BatchRow = {
  attemptId: string;
  ordinal: number;
  batchId: string | null;
  customId: string;
  requestSha256: string;
  status: string;
  result: unknown | null;
};

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const noUsage = () => ({
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  raw: null,
  priceRevision: null,
});
const failure = (
  code: string,
  status: ProviderResult['status'] = 'error',
  diagnostic?: ProviderHttpDiagnostic
): ProviderResult => ({
  status,
  text: '',
  toolCalls: [],
  refusal: null,
  error: { code, ...(diagnostic ? { diagnostic } : {}) },
  usage: noUsage(),
  opaqueState: null,
});

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    timer.unref();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function batchResult(value: unknown): { customId: string; result: Record<string, unknown> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.custom_id !== 'string' || !row.result || typeof row.result !== 'object')
    return null;
  return { customId: row.custom_id, result: row.result as Record<string, unknown> };
}

function decodeResult(
  value: unknown,
  customId: string,
  context: ReturnType<typeof encodeAnthropic>['context']
): ProviderResult {
  const entry = batchResult(value);
  if (!entry || entry.customId !== customId) return failure('ANTHROPIC_BATCH_RESULT_MISMATCH');
  const type = entry.result.type;
  if (type === 'succeeded') {
    if (!('message' in entry.result)) return failure('ANTHROPIC_BATCH_INVALID_RESULT');
    return decodeAnthropicMessage(entry.result.message, context);
  }
  if (type === 'canceled') return failure('CANCELLED', 'cancelled');
  if (type === 'expired') return failure('ANTHROPIC_BATCH_EXPIRED');
  if (type === 'errored') return failure('ANTHROPIC_BATCH_ERRORED');
  return failure('ANTHROPIC_BATCH_INVALID_RESULT');
}

export function recoverableAnthropicBatchRun(store: Store, runId: string): boolean {
  const batch = store.db
    .prepare('SELECT 1 FROM anthropic_batches WHERE run_id=? LIMIT 1')
    .get(runId);
  if (!batch) return false;
  const unsafe = store.db
    .prepare(`
      SELECT 1 FROM attempts a
      WHERE a.run_id=? AND a.status='running'
        AND NOT EXISTS(SELECT 1 FROM anthropic_batches b WHERE b.attempt_id=a.id)
      LIMIT 1
    `)
    .get(runId);
  return !unsafe;
}

export class AnthropicBatchRun {
  private ordinal = 0;

  constructor(
    private readonly store: Store,
    private readonly runId: string,
    private readonly pollIntervalMs = 10_000
  ) {}

  private row(ordinal: number): BatchRow | undefined {
    const row = this.store.db
      .prepare(`
        SELECT attempt_id AS attemptId,ordinal,batch_id AS batchId,custom_id AS customId,
          request_sha256 AS requestSha256,status,result
        FROM anthropic_batches WHERE run_id=? AND ordinal=?
      `)
      .get(this.runId, ordinal) as Row | undefined;
    if (!row) return undefined;
    return {
      ...row,
      result: row.result === null ? null : JSON.parse(String(row.result)),
    } as BatchRow;
  }

  private reserve(attemptId: string, ordinal: number, requestSha256: string): BatchRow {
    const time = now();
    this.store.db
      .prepare(`
        INSERT INTO anthropic_batches(
          attempt_id,run_id,ordinal,batch_id,custom_id,request_sha256,status,result,created_at,updated_at
        ) VALUES(?,?,?,NULL,?,?,'reserved',NULL,?,?)
      `)
      .run(attemptId, this.runId, ordinal, attemptId, requestSha256, time, time);
    return this.row(ordinal)!;
  }

  private bindBatch(attemptId: string, batchId: string, status: string) {
    this.store.db
      .prepare('UPDATE anthropic_batches SET batch_id=?,status=?,updated_at=? WHERE attempt_id=?')
      .run(batchId, status, now(), attemptId);
  }

  private updateStatus(attemptId: string, status: string) {
    this.store.db
      .prepare('UPDATE anthropic_batches SET status=?,updated_at=? WHERE attempt_id=?')
      .run(status, now(), attemptId);
  }

  private saveResult(attemptId: string, value: unknown) {
    this.store.db
      .prepare(
        "UPDATE anthropic_batches SET status='ended',result=?,updated_at=? WHERE attempt_id=?"
      )
      .run(JSON.stringify(value), now(), attemptId);
  }

  private async json(
    url: string,
    init: RequestInit & { signal: AbortSignal },
    secret: string
  ): Promise<{ response: Response; value?: unknown; diagnostic?: ProviderHttpDiagnostic }> {
    const response = await fetch(url, providerFetchOptions(init));
    if (!response.ok)
      return {
        response,
        diagnostic: await readProviderHttpDiagnostic(response, init.signal, secret),
      };
    try {
      return { response, value: await response.json() };
    } catch {
      return { response };
    }
  }

  private async cancelRemote(
    endpoint: string,
    batchId: string,
    headers: Record<string, string>
  ): Promise<void> {
    try {
      const signal = AbortSignal.timeout(10_000);
      await fetch(
        `${endpoint}/messages/batches/${encodeURIComponent(batchId)}/cancel`,
        providerFetchOptions({ method: 'POST', headers, signal, redirect: 'error' })
      );
    } catch {
      // Local cancellation owns the Run state; remote cancellation is best-effort.
    }
  }

  async execute(
    connectionValue: ProviderConnection,
    requestValue: ProviderRequest,
    options: ProviderExecutionOptions
  ): Promise<ProviderResult> {
    const ordinal = this.ordinal++;
    try {
      const connection = validateConnection(connectionValue);
      if (connection.protocol !== 'anthropic-messages-v1')
        throw new ProviderContractError('ANTHROPIC_BATCH_PROTOCOL_REQUIRED');
      const request = validateRequest(requestValue);
      const prepared = encodeAnthropic(request);
      const rawBody = prepared.body as Record<string, Json>;
      const { stream: _stream, ...params } = rawBody;
      assertContextBudget(params as Json, request.contextBudget);
      const endpoint = validateProviderEndpoint(connection.protocol, connection.endpoint);
      const secret = connection.credentialRef
        ? await (options.resolveCredential ?? ((name) => process.env[name]))(
            connection.credentialRef,
            connection,
            options.signal
          )
        : undefined;
      if (!secret || /[\r\n]/u.test(secret))
        throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': secret,
      };
      const requestBody = JSON.stringify(params);
      const requestSha256 = sha(requestBody);
      const existing = this.row(ordinal);
      if (existing && existing.requestSha256 !== requestSha256)
        return failure('ANTHROPIC_BATCH_RECOVERY_MISMATCH');
      const wire: WireRecord = {
        connectionId: connection.id,
        protocol: connection.protocol,
        role: request.role,
        modelId: request.modelId,
        method: 'POST',
        url: endpoint + '/messages/batches',
        headers: {
          'content-type': headers['content-type'],
          accept: headers.accept,
          'anthropic-version': headers['anthropic-version'],
          'x-api-key': '[REDACTED]',
        },
        body: {
          execution_mode: 'batch',
          request: diagnosticAnthropicBody(params as Json),
        },
        bodySha256: requestSha256,
        stablePrefixSha256: sha(JSON.stringify(request.stable)),
        executionMode: 'batch',
      };
      const attemptId = await options.onWire?.(wire, existing?.attemptId);
      if (typeof attemptId !== 'string' || !attemptId)
        throw new ProviderContractError('ATTEMPT_ID_REQUIRED');
      let state = existing ?? this.reserve(attemptId, ordinal, requestSha256);
      if (state.attemptId !== attemptId || state.customId !== attemptId)
        return failure('ANTHROPIC_BATCH_RECOVERY_MISMATCH');

      if (state.result !== null)
        return decodeResult(state.result, state.customId, prepared.context);
      if (!state.batchId && existing && state.status !== 'reserved')
        return failure('ANTHROPIC_BATCH_CREATE_UNCERTAIN');

      if (!state.batchId) {
        this.updateStatus(attemptId, 'creating');
        state = this.row(ordinal)!;
        const created = await this.json(
          endpoint + '/messages/batches',
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              requests: [{ custom_id: state.customId, params }],
            }),
            signal: options.signal,
            redirect: 'error',
          },
          secret
        );
        if (!created.response.ok)
          return failure(`HTTP_${created.response.status}`, 'error', created.diagnostic);
        const value = created.value as Record<string, unknown> | undefined;
        if (
          !value ||
          typeof value.id !== 'string' ||
          !value.id ||
          !['in_progress', 'canceling', 'ended'].includes(String(value.processing_status))
        )
          return failure('ANTHROPIC_BATCH_INVALID_RESPONSE');
        this.bindBatch(attemptId, value.id, String(value.processing_status));
        state = this.row(ordinal)!;
      }

      let processing = state.status;
      while (processing !== 'ended') {
        if (options.signal.aborted) throw options.signal.reason;
        const polled = await this.json(
          `${endpoint}/messages/batches/${encodeURIComponent(state.batchId!)}`,
          { method: 'GET', headers, signal: options.signal, redirect: 'error' },
          secret
        );
        if (!polled.response.ok)
          return failure(`HTTP_${polled.response.status}`, 'error', polled.diagnostic);
        const value = polled.value as Record<string, unknown> | undefined;
        if (
          !value ||
          value.id !== state.batchId ||
          !['in_progress', 'canceling', 'ended'].includes(String(value.processing_status))
        )
          return failure('ANTHROPIC_BATCH_INVALID_RESPONSE');
        processing = String(value.processing_status);
        this.updateStatus(attemptId, processing);
        if (processing !== 'ended') await wait(this.pollIntervalMs, options.signal);
      }

      const resultResponse = await fetch(
        `${endpoint}/messages/batches/${encodeURIComponent(state.batchId!)}/results`,
        providerFetchOptions({ method: 'GET', headers, signal: options.signal, redirect: 'error' })
      );
      if (!resultResponse.ok) {
        const diagnostic = await readProviderHttpDiagnostic(resultResponse, options.signal, secret);
        return failure(`HTTP_${resultResponse.status}`, 'error', diagnostic);
      }
      const text = await resultResponse.text();
      let match: unknown | undefined;
      for (const line of text.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return failure('ANTHROPIC_BATCH_INVALID_RESULT');
        }
        const parsed = batchResult(value);
        if (parsed?.customId === state.customId) {
          if (match !== undefined) return failure('ANTHROPIC_BATCH_RESULT_MISMATCH');
          match = value;
        }
      }
      if (match === undefined) return failure('ANTHROPIC_BATCH_RESULT_MISMATCH');
      this.saveResult(attemptId, match);
      return decodeResult(match, state.customId, prepared.context);
    } catch (error) {
      if (options.signal.aborted) {
        const state = this.row(ordinal);
        if (state?.batchId && options.cancelRemoteOnAbort?.()) {
          try {
            const connection = validateConnection(connectionValue);
            const secret = connection.credentialRef
              ? await (options.resolveCredential ?? ((name) => process.env[name]))(
                  connection.credentialRef,
                  connection,
                  AbortSignal.timeout(10_000)
                )
              : undefined;
            if (secret) {
              const endpoint = validateProviderEndpoint(connection.protocol, connection.endpoint);
              await this.cancelRemote(endpoint, state.batchId, {
                'content-type': 'application/json',
                accept: 'application/json',
                'anthropic-version': '2023-06-01',
                'x-api-key': secret,
              });
            }
          } catch {
            // Best-effort remote cancellation must never override the local cancellation result.
          }
        }
        return failure('CANCELLED', 'cancelled');
      }
      const code =
        error instanceof ProviderContractError || error instanceof AnthropicProtocolError
          ? error.code
          : transportFailureCode(error);
      return failure(code);
    }
  }
}
