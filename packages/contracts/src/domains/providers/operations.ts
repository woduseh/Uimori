import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';

export const REJECTED_OPTIONS = [
  'thinking',
  'temperature',
  'topP',
  'maxOutputTokens',
  'stopSequences',
  'serviceTier',
  'cache',
  'structuredOutput',
  'verbosity',
  'reasoningMode',
  'reasoningContext',
  'model',
  'tools',
  'input',
] as const;

export const providerRejection = z.strictObject({
  httpStatus: z.int(),
  providerCode: z.string().optional(),
  options: z.array(z.enum(REJECTED_OPTIONS)),
  unmappedFields: z.array(z.string()).optional(),
  message: z.string().optional(),
});
export type ProviderRejection = z.infer<typeof providerRejection>;
export type RejectedOption = ProviderRejection['options'][number];

export const pricingLine = z.strictObject({
  kind: z.enum(['input', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'output']),
  tokens: z.number().nullable(),
  rate: z.number().nullable(),
  usd: z.number().nullable(),
});
export type PricingLine = z.infer<typeof pricingLine>;

export const costEstimate = z.strictObject({
  status: z.enum(['estimated', 'partial', 'unavailable']),
  usd: z.number().nullable(),
  subtotalUsd: z.number(),
  lines: z.array(pricingLine),
  notes: z.array(z.string()),
});
export type CostEstimate = z.infer<typeof costEstimate>;

export const providerConnectionTest = z.strictObject({
  id: z.string(),
  modelId: z.string(),
  modelRevision: revision,
  providerModelId: z.string(),
  connectionId: z.string(),
  location: z.string().optional(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum([
    'running',
    'completed',
    'refused',
    'partial',
    'error',
    'cancelled',
    'interrupted',
  ]),
  text: z.string(),
  truncated: z.boolean(),
  latencyMs: z.number().nullable(),
  error: z.string().nullable(),
  rejection: providerRejection.optional(),
  usage: z.strictObject({
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    costUsd: z.number().nullable(),
  }),
  estimatedCost: costEstimate.optional(),
});
export type ProviderConnectionTest = z.infer<typeof providerConnectionTest>;

export const jevSettings = z.strictObject({
  revision,
  images: z.boolean(),
  longContext: z.boolean(),
});
export type JevSettings = z.infer<typeof jevSettings>;

export const jevProviderStatus = z.strictObject({
  revision,
  configured: z.boolean(),
  credentialSource: z.enum(['saved', 'environment', 'missing']),
  hasSavedKey: z.boolean(),
  modelId: z.string(),
  endpoint: z.string(),
  latestTest: providerConnectionTest.nullable(),
  settings: jevSettings,
});
export type JevProviderStatus = z.infer<typeof jevProviderStatus>;

export const codexRuntimeStatus = z.strictObject({
  available: z.boolean(),
  authenticated: z.boolean(),
  authMode: z.enum(['chatgpt', 'apikey']).nullable(),
  error: z.string().nullable(),
  login: z
    .strictObject({ id: z.string(), verificationUrl: z.string(), userCode: z.string() })
    .nullable(),
  planType: z.string().nullable(),
  credits: z
    .strictObject({
      balance: z.number().nullable(),
      hasCredits: z.boolean(),
      unlimited: z.boolean(),
    })
    .nullable()
    .optional(),
  limits: z.array(
    z.strictObject({
      name: z.string(),
      usedPercent: z.number(),
      resetsAt: z.number().nullable(),
      windowDurationMins: z.number().nullable(),
    })
  ),
});
export type CodexRuntimeStatus = z.infer<typeof codexRuntimeStatus>;

const none = z.strictObject({});
const expected = z.strictObject({ expectedRevision: revision });
const idempotencyKey = nonBlank(200);

export const startModelTestInput = z.strictObject({
  id: nonBlank(100),
  expectedRevision: revision,
  idempotencyKey,
  location: nonBlank(40).optional(),
});
export type StartModelTest = z.infer<typeof startModelTestInput>;

export const providerOperations = {
  readCodexRuntime: defineOperation('providers.readCodexRuntime', none, codexRuntimeStatus),
  startCodexLogin: defineOperation('providers.startCodexLogin', none, codexRuntimeStatus),
  cancelCodexLogin: defineOperation('providers.cancelCodexLogin', none, codexRuntimeStatus),
  signOutCodex: defineOperation('providers.signOutCodex', none, codexRuntimeStatus),
  readJev: defineOperation('providers.readJev', none, jevProviderStatus),
  saveJevKey: defineOperation(
    'providers.saveJevKey',
    z.strictObject({ expectedRevision: revision, apiKey: nonBlank(4096) }),
    jevProviderStatus
  ),
  deleteJevKey: defineOperation('providers.deleteJevKey', expected, jevProviderStatus),
  updateJevSettings: defineOperation(
    'providers.updateJevSettings',
    z.strictObject({ expectedRevision: revision, images: z.boolean(), longContext: z.boolean() }),
    jevProviderStatus
  ),
  startJevTest: defineOperation(
    'providers.startJevTest',
    z.strictObject({ expectedRevision: revision, idempotencyKey }),
    providerConnectionTest
  ),
  startModelTest: defineOperation(
    'providers.startModelTest',
    startModelTestInput,
    providerConnectionTest
  ),
  readConnectionTest: defineOperation(
    'providers.readConnectionTest',
    z.strictObject({ id: nonBlank(200) }),
    providerConnectionTest
  ),
  validateVertexCredential: defineOperation(
    'providers.validateVertexCredential',
    z.strictObject({ serviceAccount: z.unknown() }),
    z.strictObject({ projectId: z.string(), clientEmail: z.string() })
  ),
};
