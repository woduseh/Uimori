import type { ProviderHttpDiagnostic } from './provider-http-error.js';
import {
  GENERATION_KEYS,
  validateGenerationShape,
  validateModelOptions,
} from './model-capabilities.js';
import { createHash } from 'node:crypto';
import {
  validateProviderEndpoint,
  PROVIDER_PROTOCOLS,
  type ProviderProtocol,
  type VertexRequestTier,
  type ModelGeneration,
} from './product.js';
import { executeVertexProvider } from './vertex.js';
import { executeNativeProvider } from './provider-http.js';
import { validateProviderPrompt, type ProviderPrompt } from './prompt-program.js';
import { ProviderContractError } from './provider-errors.js';
import {
  isVertexFileReference,
  validVertexFileReference,
  validCredentialEnv,
} from './credential-reference.js';
import {
  assertContextBudget,
  validateContextBudget,
  type ContextBudget,
} from './context-budget.js';
import { providerOriginApproval } from './provider-origin-policy.js';
import { validatePricingSnapshot } from './model-pricing.js';
import type { PricingSnapshot } from './pricing-types.js';
import { createPublicTextProgress, type ProviderProgress } from './provider-progress.js';
export type { ProviderProgress } from './provider-progress.js';
export { ProviderContractError } from './provider-errors.js';

/** This versioned loopback protocol is a local fixture, not a live API claim. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ProviderRole =
  | 'main'
  | 'translation'
  | 'status'
  | 'image'
  | 'state'
  | 'context'
  | 'helper'
  | 'title'
  | 'illustration';
export type ProviderConnection = {
  id: string;
  protocol: ProviderProtocol;
  endpoint: string;
  credentialEnv?: string;
};
export type ProviderTool = { name: string; description: string; inputSchema: Json };
export type ProviderRequest = {
  /** Frozen host pricing metadata; never serialized into a provider payload. */
  pricingSnapshot?: PricingSnapshot;
  role: ProviderRole;
  modelId: string;
  stable: { contract: string; tools: ProviderTool[] };
  generation?: ModelGeneration;
  /** Immutable host input policy. Never serialized as a provider generation option. */
  contextBudget?: ContextBudget;
  /** Host baseline used only for continuation binding when an intermediate evaluation round lowers tokens or effort. Never sent to a provider. */
  generationBinding?: ModelGeneration;
  prompt?: ProviderPrompt;
  bootstrap?: {
    callId: string;
    name: string;
    args: Record<string, Json>;
    result: Json;
    denied: boolean;
  }[];
  /** Host tool name to require for this round. Omit to leave provider tool selection automatic. */
  toolChoice?: string;
  input: {
    task: string;
    controls: Record<string, string | number | boolean | null>;
    source?: Json;
    catalog?: Json;
    results?: Json;
    history?: Json;
  };
  opaqueState?: Json;
};
export type ProviderUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  raw: Json;
  priceRevision: string | null;
};
export type ProviderToolCall = {
  id: string;
  name: string;
  arguments: Record<string, Json>;
  recoveredFromTruncation?: boolean;
};
export type ProviderResult = {
  status: 'completed' | 'tool_calls' | 'refused' | 'partial' | 'error' | 'cancelled';
  text: string;
  toolCalls: ProviderToolCall[];
  refusal: string | null;
  error: { code: string; diagnostic?: ProviderHttpDiagnostic } | null;
  usage: ProviderUsage;
  opaqueState: Json;
  delivery?: {
    kind: 'evaluation-artifact';
    noticeProvided: boolean;
    noticeCharacters: number;
    correctionCount: number;
  };
};
export type WireRecord = {
  pricingSnapshot?: PricingSnapshot;
  pricingStartedAt?: string;
  /** Host-only attribution. Never supplied by model output or serialized to the provider. */
  agentId?: string;
  connectionId: string;
  protocol: ProviderConnection['protocol'];
  role: ProviderRole;
  modelId: string;
  method: 'POST' | 'RPC';
  url: string;
  headers: Record<string, string>;
  body: Json;
  bodySha256: string;
  stablePrefixSha256: string;
};
export type CatalogModel = {
  id: string;
  label: string;
  capabilities: { tools: boolean | null; structuredOutput: boolean | null };
  pricing: {
    inputUsdPerMillion: number | null;
    outputUsdPerMillion: number | null;
    revision: string | null;
  };
  origin: 'catalog' | 'manual';
};

function reject(code: string): never {
  throw new ProviderContractError(code);
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(
  value: unknown,
  allowed: readonly string[]
): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    reject('UNSUPPORTED_OPTIONS');
}
function string(value: unknown, max = 200): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) reject('INVALID_STRING');
}
function numeric(value: unknown, integer = false): number | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    reject('INVALID_USAGE');
  return value;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Only validated official roots or host-approved origins are eligible; content cannot approve one. */
export function validateConnection(
  value: unknown,
  approvedOrigins: readonly string[]
): ProviderConnection {
  keys(value, ['id', 'protocol', 'endpoint', 'credentialEnv']);
  string(value.id);
  string(value.endpoint, 2048);
  if (!PROVIDER_PROTOCOLS.includes(value.protocol as ProviderProtocol))
    reject('UNSUPPORTED_PROTOCOL');
  if (value.protocol === 'codex-app-server-v1') {
    if (value.endpoint !== 'codex://local' || value.credentialEnv !== undefined)
      reject('INVALID_CODEX_CONNECTION');
    return { id: value.id, protocol: value.protocol, endpoint: value.endpoint };
  }
  let url: URL;
  try {
    url = new URL(value.endpoint);
  } catch {
    return reject('INVALID_ENDPOINT');
  }
  const approval = providerOriginApproval(
    value.protocol as ProviderProtocol,
    value.endpoint,
    approvedOrigins
  );
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!approval && !approvedOrigins.includes(url.origin))
  )
    reject('ENDPOINT_NOT_APPROVED');
  // An unselected fixture protocol never becomes a generic remote proxy.
  if (
    value.protocol === 'fixture-sse-v1' &&
    (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname))
  )
    reject('FIXTURE_REQUIRES_LOOPBACK');
  try {
    validateProviderEndpoint(value.protocol as ProviderProtocol, url.href);
  } catch {
    reject(
      value.protocol === 'vertex-gemini-v1'
        ? 'INVALID_VERTEX_ENDPOINT'
        : 'INVALID_PROVIDER_ENDPOINT'
    );
  }
  if (!approval) reject('ENDPOINT_NOT_APPROVED');
  if (value.credentialEnv !== undefined && !validCredentialEnv(value.credentialEnv))
    reject('INVALID_CREDENTIAL_REFERENCE');
  if (
    typeof value.credentialEnv === 'string' &&
    isVertexFileReference(value.credentialEnv) &&
    (value.protocol !== 'vertex-gemini-v1' || !validVertexFileReference(value.credentialEnv))
  )
    reject('INVALID_CREDENTIAL_REFERENCE');
  return {
    id: value.id,
    protocol: value.protocol as ProviderProtocol,
    endpoint: url.href,
    ...(value.credentialEnv ? { credentialEnv: value.credentialEnv as string } : {}),
  };
}

function validateGeneration(value: unknown): asserts value is ModelGeneration {
  validateGenerationShape(value);
}

export function validateRequest(value: unknown): ProviderRequest {
  keys(value, [
    'pricingSnapshot',
    'role',
    'modelId',
    'stable',
    'generation',
    'generationBinding',
    'contextBudget',
    'input',
    'opaqueState',
    'prompt',
    'bootstrap',
    'toolChoice',
  ]);
  if (value.pricingSnapshot !== undefined) validatePricingSnapshot(value.pricingSnapshot);
  if (value.prompt !== undefined) {
    try {
      validateProviderPrompt(value.prompt);
    } catch (error) {
      reject(error instanceof Error ? error.message : 'INVALID_PROMPT');
    }
  }
  if (
    ![
      'main',
      'translation',
      'status',
      'image',
      'state',
      'context',
      'helper',
      'title',
      'illustration',
    ].includes(value.role as string)
  )
    reject('INVALID_ROLE');
  string(value.modelId);
  if (value.generation !== undefined) validateGeneration(value.generation);
  if (value.contextBudget !== undefined) validateContextBudget(value.contextBudget);
  if (value.generationBinding !== undefined) {
    validateGeneration(value.generationBinding);
    if (value.generation === undefined) reject('INVALID_GENERATION_BINDING');
    for (const key of GENERATION_KEYS.filter(
      (key) => !['maxOutputTokens', 'reasoningEffort', 'outputEffort'].includes(key)
    ))
      if (JSON.stringify(value.generation[key]) !== JSON.stringify(value.generationBinding[key]))
        reject('INVALID_GENERATION_BINDING');
    if (value.generation.maxOutputTokens > value.generationBinding.maxOutputTokens)
      reject('INVALID_GENERATION_BINDING');
    for (const key of ['reasoningEffort', 'outputEffort'] as const) {
      const before = value.generationBinding[key],
        after = value.generation[key];
      if (
        after !== before &&
        !(before !== undefined && after === 'low' && !['none', 'minimal'].includes(before))
      )
        reject('INVALID_GENERATION_BINDING');
    }
  }
  if (value.bootstrap !== undefined) {
    if (!Array.isArray(value.bootstrap) || value.bootstrap.length > 8) reject('INVALID_BOOTSTRAP');
    const ids = new Set<string>();
    for (const item of value.bootstrap) {
      keys(item, ['callId', 'name', 'args', 'result', 'denied']);
      string(item.callId);
      string(item.name);
      if (
        ids.has(item.callId) ||
        !object(item.args) ||
        typeof item.denied !== 'boolean' ||
        !Object.hasOwn(item, 'result')
      )
        reject('INVALID_BOOTSTRAP');
      ids.add(item.callId);
    }
  }
  keys(value.stable, ['contract', 'tools']);
  // An explicitly selected empty prompt is distinct from using the application default.
  if (typeof value.stable.contract !== 'string' || value.stable.contract.length > 200_000)
    reject('INVALID_STRING');
  if (!Array.isArray(value.stable.tools) || value.stable.tools.length > 32) reject('INVALID_TOOLS');
  const names = new Set<string>();
  for (const tool of value.stable.tools) {
    keys(tool, ['name', 'description', 'inputSchema']);
    string(tool.name);
    string(tool.description, 4000);
    if (names.has(tool.name) || !object(tool.inputSchema)) reject('INVALID_TOOLS');
    names.add(tool.name);
  }
  if (value.toolChoice !== undefined) {
    string(value.toolChoice);
    if (value.toolChoice !== 'auto' && !names.has(value.toolChoice)) reject('INVALID_TOOL_CHOICE');
  }
  keys(value.input, ['task', 'controls', 'source', 'catalog', 'results', 'history']);
  string(value.input.task, 500_000);
  if (
    !object(value.input.controls) ||
    Object.entries(value.input.controls).some(
      ([key, val]) =>
        key.length > 100 ||
        (val !== null && !['string', 'number', 'boolean'].includes(typeof val)) ||
        (typeof val === 'number' && !Number.isFinite(val))
    )
  )
    reject('INVALID_CONTROLS');
  // JSON round-trip rejects circular/non-serializable application data before fetch.
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return reject('INVALID_JSON');
  }
  if (encoded.length > 2_000_000) reject('REQUEST_TOO_LARGE');
  return JSON.parse(encoded) as ProviderRequest;
}

/** Parse data into fresh entries. No catalog field can mutate connection authority. */
export function parseCatalog(value: unknown): CatalogModel[] {
  keys(value, ['models']);
  if (!Array.isArray(value.models) || value.models.length > 5000) reject('INVALID_CATALOG');
  const ids = new Set<string>();
  return value.models.map((raw) => {
    keys(raw, ['id', 'label', 'capabilities', 'pricing']);
    string(raw.id);
    string(raw.label, 400);
    if (ids.has(raw.id)) reject('DUPLICATE_MODEL');
    ids.add(raw.id);
    const cap = raw.capabilities ?? {};
    keys(cap, ['tools', 'structuredOutput']);
    if (Object.values(cap).some((v) => v !== null && typeof v !== 'boolean'))
      reject('INVALID_CAPABILITY');
    const price = raw.pricing ?? {};
    keys(price, ['inputUsdPerMillion', 'outputUsdPerMillion', 'revision']);
    if (price.revision !== undefined && price.revision !== null) string(price.revision);
    return {
      id: raw.id,
      label: raw.label,
      capabilities: {
        tools: (cap.tools ?? null) as boolean | null,
        structuredOutput: (cap.structuredOutput ?? null) as boolean | null,
      },
      pricing: {
        inputUsdPerMillion: numeric(price.inputUsdPerMillion),
        outputUsdPerMillion: numeric(price.outputUsdPerMillion),
        revision: (price.revision ?? null) as string | null,
      },
      origin: 'catalog',
    };
  });
}
export function registerManualModel(id: string): CatalogModel {
  string(id);
  return {
    id,
    label: id,
    capabilities: { tools: null, structuredOutput: null },
    pricing: { inputUsdPerMillion: null, outputUsdPerMillion: null, revision: null },
    origin: 'manual',
  };
}
export function refreshCatalog(
  previous: readonly CatalogModel[],
  payload: unknown
): { models: CatalogModel[]; error: string | null } {
  try {
    const incoming = parseCatalog(payload);
    return {
      models: [
        ...incoming,
        ...previous
          .filter(
            (model) => model.origin === 'manual' && !incoming.some((item) => item.id === model.id)
          )
          .map((model) => structuredClone(model)),
      ],
      error: null,
    };
  } catch (error) {
    return {
      models: structuredClone([...previous]),
      error: error instanceof ProviderContractError ? error.code : 'CATALOG_UNAVAILABLE',
    };
  }
}

function redact(value: Json, secret?: string): Json {
  if (typeof value === 'string') return secret ? value.split(secret).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|api[_-]?key|credential|secret|password|access[_-]?token)$/i.test(key)
          ? '[REDACTED]'
          : redact(item as Json, secret),
      ])
    );
  return value;
}

/** Fetch + fatal UTF-8 decoder + SSE assembler. Never retries or follows redirects. */
export type ProviderExecutionOptions = {
  executeCodex?: (
    connection: ProviderConnection,
    request: ProviderRequest,
    options: ProviderExecutionOptions
  ) => Promise<ProviderResult>;
  approvedOrigins: readonly string[];
  signal: AbortSignal;
  timeoutMs?: number;
  vertexRequestTier?: VertexRequestTier;
  resolveCredential?: (
    envReference: string,
    connection?: ProviderConnection,
    signal?: AbortSignal
  ) => string | undefined | Promise<string | undefined>;
  /** Synchronous host authorization after Codex thread setup and immediately before turn/start; never records another attempt. */
  beforeTurn?: () => void;
  onWire?: (record: WireRecord) => void | Promise<void>;
  /** Decoder-selected public answer deltas; excludes tools, reasoning and final-only envelopes. */
  onProgress?: (progress: ProviderProgress) => void | Promise<void>;
};
export async function executeProvider(
  connectionValue: ProviderConnection,
  requestValue: ProviderRequest,
  options: ProviderExecutionOptions
): Promise<ProviderResult> {
  if (requestValue.pricingSnapshot) {
    let pricingSnapshot = validatePricingSnapshot(requestValue.pricingSnapshot);
    if (
      pricingSnapshot.protocol !== connectionValue.protocol ||
      pricingSnapshot.modelId !== requestValue.modelId
    )
      reject('PRICING_SNAPSHOT_MISMATCH');
    if (
      connectionValue.protocol === 'vertex-gemini-v1' &&
      options.vertexRequestTier &&
      options.vertexRequestTier !== pricingSnapshot.serviceTier
    ) {
      const forced = options.vertexRequestTier;
      const rates = forced === 'flex' ? pricingSnapshot.flexRates : pricingSnapshot.standardRates;
      pricingSnapshot = {
        ...pricingSnapshot,
        serviceTier: forced,
        rates: rates ?? { input: null, cacheRead: null, cacheWrite: null, output: null },
        longContext:
          forced === 'flex' ? pricingSnapshot.flexLongContext : pricingSnapshot.longContext,
      };
    }
    const onWire = options.onWire;
    options = {
      ...options,
      onWire: (wire) =>
        onWire?.({ ...wire, pricingSnapshot, pricingStartedAt: new Date().toISOString() }),
    };
  }
  if (connectionValue.protocol === 'codex-app-server-v1') {
    const connection = validateConnection(connectionValue, options.approvedOrigins),
      request = validateRequest(requestValue);
    if (request.generation) validateModelOptions(request.generation, connection.protocol);
    if (options.executeCodex)
      return options.executeCodex(connection, request, { ...options, onProgress: undefined });
    return {
      status: 'error',
      text: '',
      toolCalls: [],
      refusal: null,
      error: { code: 'CODEX_UNAVAILABLE' },
      usage: {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        raw: null,
        priceRevision: null,
      },
      opaqueState: null,
    };
  }
  if (connectionValue.protocol === 'vertex-gemini-v1')
    return executeVertexProvider(connectionValue, requestValue, options);
  if (connectionValue.protocol !== 'fixture-sse-v1')
    return executeNativeProvider(connectionValue, requestValue, options);
  const result: ProviderResult = {
    status: 'error',
    text: '',
    toolCalls: [],
    refusal: null,
    error: null,
    usage: { inputTokens: null, outputTokens: null, costUsd: null, raw: null, priceRevision: null },
    opaqueState: null,
  };
  const fragments = new Map<number, { id: string; name: string; args: string }>();
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000)
    reject('INVALID_TIMEOUT');
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([options.signal, timeout]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let secret: string | undefined;
  const failure = (code: string) => {
    result.status = options.signal.aborted
      ? 'cancelled'
      : result.refusal
        ? 'refused'
        : result.text || fragments.size
          ? 'partial'
          : 'error';
    result.error = {
      code: options.signal.aborted ? 'CANCELLED' : timeout.aborted ? 'TIMEOUT' : code,
    };
    return result;
  };
  try {
    const connection = validateConnection(connectionValue, options.approvedOrigins);
    const request = validateRequest(requestValue);
    const progress = createPublicTextProgress(request, connection.protocol, { ...options, signal });
    if (signal.aborted) return failure('CANCELLED');
    // Stable prefix precedes dynamic controls and sources in the serialized body.
    const stablePrefix = JSON.stringify({
      protocol: connection.protocol,
      role: request.role,
      stable: request.stable,
    });
    const bodyValue = {
      protocol: connection.protocol,
      role: request.role,
      stable: request.stable,
      modelId: request.modelId,
      ...(request.generation ? { generation: request.generation } : {}),
      ...(request.bootstrap ? { bootstrap: request.bootstrap } : {}),
      ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
      input: request.input,
      ...(request.prompt ? { prompt: request.prompt } : {}),
      ...(request.opaqueState !== undefined ? { opaqueState: request.opaqueState } : {}),
    };
    assertContextBudget(bodyValue, request.contextBudget);
    const body = JSON.stringify(bodyValue);
    if (connection.credentialEnv) {
      secret = await (options.resolveCredential ?? ((name) => process.env[name]))(
        connection.credentialEnv,
        connection,
        signal
      );
      if (!secret || /[\r\n]/u.test(secret)) reject('CREDENTIAL_UNAVAILABLE');
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    };
    await options.onWire?.({
      connectionId: connection.id,
      protocol: connection.protocol,
      role: request.role,
      modelId: request.modelId,
      method: 'POST',
      url: connection.endpoint,
      headers: { ...headers, ...(secret ? { authorization: '[REDACTED]' } : {}) },
      body: redact(JSON.parse(body) as Json, secret),
      bodySha256: sha(body),
      stablePrefixSha256: sha(stablePrefix),
    });
    if (signal.aborted) return failure('CANCELLED');
    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers,
      body,
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(`HTTP_${response.status}`);
    }
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
      await response.body?.cancel();
      return failure('INVALID_CONTENT_TYPE');
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let data: string[] = [];
    let dataLength = 0;
    let total = 0;
    const dispatch = async (): Promise<boolean> => {
      if (!data.length) return false;
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data.join('\n'));
        if (!object(parsed)) reject('INVALID_EVENT');
        event = parsed;
      } catch {
        return reject('INVALID_EVENT');
      }
      data = [];
      dataLength = 0;
      switch (event.type) {
        case 'text_delta':
          if (typeof event.delta !== 'string') reject('INVALID_EVENT');
          result.text += event.delta;
          await progress(result.text);
          break;
        case 'tool_delta': {
          if (
            !Number.isSafeInteger(event.index) ||
            (event.index as number) < 0 ||
            (event.index as number) > 31
          )
            reject('INVALID_TOOL_DELTA');
          const index = event.index as number;
          const fragment = fragments.get(index) ?? { id: '', name: '', args: '' };
          if (event.id !== undefined) {
            string(event.id);
            if (fragment.id && fragment.id !== event.id) reject('TOOL_ID_CHANGED');
            fragment.id = event.id;
          }
          if (event.name !== undefined) {
            string(event.name);
            if (fragment.name && fragment.name !== event.name) reject('TOOL_NAME_CHANGED');
            fragment.name = event.name;
          }
          if (event.argumentsDelta !== undefined) {
            if (typeof event.argumentsDelta !== 'string') reject('INVALID_TOOL_DELTA');
            fragment.args += event.argumentsDelta;
          }
          fragments.set(index, fragment);
          break;
        }
        case 'usage': {
          keys(event, ['type', 'inputTokens', 'outputTokens', 'costUsd', 'raw', 'priceRevision']);
          if (event.priceRevision !== undefined && event.priceRevision !== null)
            string(event.priceRevision);
          result.usage = {
            inputTokens: numeric(event.inputTokens, true),
            outputTokens: numeric(event.outputTokens, true),
            costUsd: numeric(event.costUsd),
            raw: redact((event.raw ?? null) as Json, secret),
            priceRevision: (event.priceRevision ?? null) as string | null,
          };
          break;
        }
        case 'opaque_state':
          result.opaqueState = (event.state ?? null) as Json;
          break;
        case 'refusal':
          string(event.message, 10_000);
          result.refusal = event.message;
          break;
        case 'error':
          failure('PROVIDER_ERROR');
          return true;
        case 'done': {
          if (!['stop', 'tool_calls', 'refusal'].includes(event.reason as string))
            reject('INVALID_TERMINAL');
          if (result.refusal) {
            result.status = 'refused';
            return true;
          }
          if (event.reason === 'refusal') reject('INVALID_TERMINAL');
          const ids = new Set<string>();
          for (const [, fragment] of [...fragments].sort(([a], [b]) => a - b)) {
            string(fragment.id);
            string(fragment.name);
            if (ids.has(fragment.id)) reject('DUPLICATE_TOOL_ID');
            ids.add(fragment.id);
            let args: unknown;
            try {
              args = JSON.parse(fragment.args);
            } catch {
              return reject('INVALID_TOOL_ARGUMENTS');
            }
            if (!object(args)) reject('INVALID_TOOL_ARGUMENTS');
            result.toolCalls.push({
              id: fragment.id,
              name: fragment.name,
              arguments: args as Record<string, Json>,
            });
          }
          if ((event.reason === 'tool_calls') !== result.toolCalls.length > 0)
            reject('INVALID_TERMINAL');
          if (event.reason === 'stop' && !result.text.trim()) reject('EMPTY_COMPLETION');
          result.status = event.reason === 'stop' ? 'completed' : 'tool_calls';
          return true;
        }
        default:
          reject('UNSUPPORTED_EVENT');
      }
      return false;
    };
    while (true) {
      if (signal.aborted) return failure('CANCELLED');
      const chunk = await reader.read();
      if (signal.aborted) return failure('CANCELLED');
      if (chunk.done) {
        decoder.decode();
        return failure('UNEXPECTED_EOF');
      }
      total += chunk.value.byteLength;
      if (total > 8_000_000) reject('RESPONSE_TOO_LARGE');
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 1_000_000) reject('EVENT_TOO_LARGE');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (await dispatch()) return signal.aborted ? failure('CANCELLED') : result;
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /u, '');
          data.push(value);
          dataLength += value.length;
        }
        if (dataLength > 1_000_000) reject('EVENT_TOO_LARGE');
      }
    }
  } catch (error) {
    return failure(error instanceof ProviderContractError ? error.code : 'TRANSPORT_ERROR');
  } finally {
    try {
      await reader?.cancel();
    } catch {
      /* Remote shutdown must not hide terminal evidence. */
    }
  }
}
