/**
 * Connection, request and catalog validation shared by the transport and every protocol executor.
 * Lives apart from `transport.ts` so executors can validate without importing the dispatcher.
 */
import { GENERATION_KEYS, validateGenerationShape } from './model-capabilities.js';
import { createHash } from 'node:crypto';
import {
  validateProviderEndpoint,
  PROVIDER_PROTOCOLS,
  type ProviderProtocol,
  type ModelGeneration,
} from './product.js';
import { validateProviderPrompt } from './prompt-program.js';
import { ProviderContractError } from './provider-errors.js';
import {
  isVertexFileReference,
  validVertexFileReference,
  validCredentialEnv,
} from './credential-reference.js';
import { validateContextBudget } from './context-budget.js';
import { providerOriginApproval } from './provider-origin-policy.js';
import { validatePricingSnapshot } from './model-pricing.js';
import type { CatalogModel, ProviderConnection, ProviderRequest } from './transport.js';

export function reject(code: string): never {
  throw new ProviderContractError(code);
}
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function keys(
  value: unknown,
  allowed: readonly string[]
): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    reject('UNSUPPORTED_OPTIONS');
}
export function string(value: unknown, max = 200): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) reject('INVALID_STRING');
}
export function numeric(value: unknown, integer = false): number | null {
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
export const sha = (text: string) => createHash('sha256').update(text).digest('hex');

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
