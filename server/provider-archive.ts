/**
 * Provider setting archive rows and frozen model snapshots. Kept apart from `product-store.ts` so
 * story, helper and package archives can validate models without importing the store.
 */
import { validateModelPricing, validatePricingSnapshot } from '../core/model-pricing.js';
import {
  GENERATION_KEYS,
  generationFromModel,
  modelCapability,
  validateGenerationShape,
  validateModelOptions,
} from '../core/model-capabilities.js';
import { validCredentialEnv } from '../core/credential-reference.js';
import { validateEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import {
  validateProviderEndpoint,
  PROVIDER_PROTOCOLS,
  type ModelSnapshot,
  type Connection,
  type ModelPreset,
} from '../core/product.js';
import {
  HttpError,
  archiveId,
  archiveList,
  archiveVersionBody,
  boolean,
  choice,
  fields,
  number,
  record,
  text,
} from './request-validation.js';

type Row = Record<string, any>;
const json = JSON.stringify;

export const isProviderSetting = (kind: string) => kind === 'connection' || kind === 'model';

export function connectionEndpoint(value: unknown, protocol: Connection['protocol']) {
  const endpoint = text(value, 'endpoint', 2000);
  try {
    return validateProviderEndpoint(protocol, endpoint);
  } catch {
    throw new HttpError(400, 'Invalid provider endpoint');
  }
}

export const modelOptionKeys = [
  ...GENERATION_KEYS.filter((key) => !['maxOutputTokens', 'temperature'].includes(key)),
  'timeoutMs',
  'evaluationTools',
  'contextTools',
  'inputTokenLimit',
];

export function catalogTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new HttpError(400, 'Invalid catalog timestamp');
  return value;
}

export function modelPricing(value: unknown) {
  try {
    return validateModelPricing(value);
  } catch {
    throw new HttpError(400, 'Invalid model pricing');
  }
}

export function validateModelMetadata(value: Row) {
  if (value.enabled !== undefined) boolean(value.enabled);
  if (value.pricing !== undefined) modelPricing(value.pricing);
  if (value.source !== undefined) {
    const source = record(value.source);
    fields(source, ['kind', 'catalogUpdatedAt']);
    choice(source.kind, ['catalog', 'manual'], 'model source');
    catalogTimestamp(source.catalogUpdatedAt);
  }
}

export function validateModelGeneration(value: Row, protocol?: Connection['protocol']) {
  if (value.inputTokenLimit !== undefined)
    number(value.inputTokenLimit, 'input context limit', 8192, 1000000);
  if (value.evaluationTools !== undefined)
    try {
      validateEvaluationToolOptions(value.evaluationTools);
    } catch {
      throw new HttpError(400, 'Invalid evaluation tool options');
    }
  if (value.contextTools !== undefined) boolean(value.contextTools);
  if (value.timeoutMs !== undefined)
    number(value.timeoutMs, 'timeout', 1, protocol === 'fixture-sse-v1' ? 600000 : 1800000);
  const generation = generationFromModel(value as ModelPreset);
  try {
    if (protocol) {
      validateModelOptions(generation, protocol);
      if (
        modelCapability(protocol, value.modelId)?.forcedTools === false &&
        value.evaluationTools?.contextMode === 'preloaded'
      )
        throw new Error(
          '이 모델은 강제 도구 호출을 지원하지 않아요. 평가 문맥을 모델 선택으로 설정해 주세요.'
        );
    } else validateGenerationShape(generation);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid model options');
  }
}

/** Connection and model archive rows; execution snapshots reuse the same checks. */
export function validateProviderSettingVersion(row: Row): void {
  const body = archiveVersionBody(row);
  text(body.title, 'title', 200);
  if (row.kind === 'connection') {
    fields(body, [
      'id',
      'revision',
      'title',
      'protocol',
      'endpoint',
      'credentialEnv',
      'catalogCredentialEnv',
      'enabled',
      'catalog',
      'catalogError',
      'catalogUpdatedAt',
    ]);
    const protocol = choice(body.protocol, [...PROVIDER_PROTOCOLS], 'protocol');
    if (
      body.catalogCredentialEnv !== undefined &&
      (protocol !== 'vertex-gemini-v1' ||
        !validCredentialEnv(text(body.catalogCredentialEnv, 'catalog credential reference', 200)))
    )
      throw new HttpError(400, 'Invalid catalog credential reference');
    if (body.catalogUpdatedAt !== undefined) catalogTimestamp(body.catalogUpdatedAt);
    connectionEndpoint(body.endpoint, protocol);
    if (protocol === 'codex-app-server-v1' && body.credentialEnv !== undefined)
      throw new HttpError(400, 'Invalid Codex authority');
    boolean(body.enabled);
    if (
      body.credentialEnv !== undefined &&
      !validCredentialEnv(text(body.credentialEnv, 'credential reference', 200))
    )
      throw new HttpError(400, 'Invalid credential reference');
    archiveList(body.catalog, 5000).forEach((raw) => {
      const model = record(raw);
      fields(model, [
        'id',
        'name',
        'capabilities',
        'priceRevision',
        'limits',
        'options',
        'pricing',
      ]);
      text(model.id, 'catalog ID', 300);
      text(model.name, 'catalog name', 400);
      const capabilities = record(model.capabilities);
      if (Object.values(capabilities).some((v) => v !== null && typeof v !== 'boolean'))
        throw new HttpError(400, 'Invalid catalog capabilities');
      if (model.priceRevision !== null) text(model.priceRevision, 'price revision', 200);
      if (model.pricing !== undefined) {
        const pricing = record(model.pricing);
        fields(pricing, ['rates', 'longContext', 'serviceTiers']);
        const validateRateSet = (entry: Row) => {
          fields(entry, ['rates', 'longContext']);
          modelPricing({ mode: 'manual', rates: entry.rates });
          if (entry.longContext !== undefined) {
            const long = record(entry.longContext);
            fields(long, ['aboveInputTokens', 'rates']);
            number(long.aboveInputTokens, 'pricing threshold', 1, 100_000_000);
            modelPricing({ mode: 'manual', rates: long.rates });
          }
        };
        validateRateSet({
          rates: pricing.rates,
          ...(pricing.longContext ? { longContext: pricing.longContext } : {}),
        });
        if (pricing.serviceTiers !== undefined) {
          const tiers = record(pricing.serviceTiers);
          if (
            Object.keys(tiers).length > 20 ||
            Object.keys(tiers).some(
              (tier) =>
                !/^[a-z][a-z0-9_-]{0,39}$/.test(tier) ||
                ['constructor', 'prototype', '__proto__'].includes(tier)
            )
          )
            throw new HttpError(400, 'Invalid catalog pricing tiers');
          for (const value of Object.values(tiers)) validateRateSet(record(value));
        }
      }
      if (model.limits !== undefined) {
        const limits = record(model.limits);
        fields(limits, ['maxOutputTokens', 'inputTokenLimit']);
        for (const value of Object.values(limits))
          if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 100_000_000)
            throw new HttpError(400, 'Invalid catalog limit');
      }
      if (model.options !== undefined) {
        const options = record(model.options);
        fields(options, ['thinking', 'thinkingModes']);
        for (const list of Object.values(options)) {
          if (!Array.isArray(list) || list.length > 20)
            throw new HttpError(400, 'Invalid catalog options');
          for (const item of list) text(item, 'catalog option', 40);
        }
      }
    });
    if (body.catalogError !== null) text(body.catalogError, 'catalog error', 2000);
  } else if (row.kind === 'model') {
    fields(body, [
      'id',
      'revision',
      'title',
      'connectionId',
      'modelId',
      'maxOutputTokens',
      'temperature',
      ...modelOptionKeys,
      'enabled',
      'pricing',
      'source',
      'capabilityProtocol',
    ]);
    archiveId(body.connectionId);
    text(body.modelId, 'model ID', 300);
    validateModelGeneration(
      body,
      body.capabilityProtocol === undefined
        ? undefined
        : choice(body.capabilityProtocol, [...PROVIDER_PROTOCOLS], 'model protocol')
    );
    validateModelMetadata(body);
  } else throw new HttpError(400, 'Invalid archive version kind');
}
/** Execution snapshots are self-contained evidence, independent of later setting edits. */
export function validateModelSnapshot(value: unknown): ModelSnapshot {
  const snapshot = record(value),
    { connection: rawConnection, pricingSnapshot, ...model } = snapshot,
    connection = record(rawConnection);
  validateProviderSettingVersion({
    kind: 'model',
    id: model.id,
    revision: model.revision,
    body: json(model),
  });
  validateProviderSettingVersion({
    kind: 'connection',
    id: connection.id,
    revision: connection.revision,
    body: json(connection),
  });
  if (model.connectionId !== connection.id)
    throw new HttpError(400, 'Model snapshot connection mismatch');
  if (model.capabilityProtocol !== undefined && model.capabilityProtocol !== connection.protocol)
    throw new HttpError(400, 'Model snapshot protocol mismatch');
  validateModelGeneration(model, connection.protocol);
  if (pricingSnapshot !== undefined) {
    validatePricingSnapshot(pricingSnapshot);
    if (
      pricingSnapshot.modelId !== model.modelId ||
      pricingSnapshot.protocol !== connection.protocol
    )
      throw new HttpError(400, 'Pricing snapshot model mismatch');
  }
  return structuredClone(snapshot) as ModelSnapshot;
}
