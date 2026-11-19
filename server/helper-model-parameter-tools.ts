import { protocolOptionKeys } from '../core/model-capabilities.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { Json, ProviderTool } from '../core/transport.js';
import { modelOptionKeys } from './provider-archive.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

const PARAMETER_KEYS = [
  'maxOutputTokens',
  'temperature',
  'topP',
  'stopSequences',
  'thinkingLevel',
  'reasoningEffort',
  'outputEffort',
  'thinkingMode',
  'verbosity',
  'reasoningMode',
  'reasoningContext',
] as const;
type ParameterKey = (typeof PARAMETER_KEYS)[number];
const SAVED_MODEL_KEYS = [
  'title',
  'connectionId',
  'modelId',
  'maxOutputTokens',
  'temperature',
  ...modelOptionKeys,
  'enabled',
  'pricing',
] as const;

const modelIdInput: Json = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  description: 'Saved model id from model.list or settings.read.',
};

export const HELPER_MODEL_PARAMETER_TOOLS: ProviderTool[] = [
  {
    name: 'model.parameters.read',
    description:
      "Read the generation parameters of a saved model: maximum output tokens, temperature, top-p, stop sequences and the reasoning, thinking, effort and verbosity levels it uses, together with which of them its connection's protocol accepts. Unset parameters use the provider default. Connection details and credentials are not included.",
    inputSchema: {
      type: 'object',
      properties: { modelId: modelIdInput },
      required: ['modelId'],
      additionalProperties: false,
    },
  },
  {
    name: 'model.parameters.update',
    description:
      'Change generation parameters of a saved model, for every role and chat that uses it. changes names only the parameters to change, with their new values; null removes an optional parameter so the provider default applies, and temperature null means the provider default. maxOutputTokens cannot be removed. Only the parameters that model.parameters.read lists as supported are accepted, and their values are checked as in the model settings. Other model settings, pricing and the connection are kept. Work that is already reserved keeps its earlier parameters. Take expectedRevision from model.parameters.read.',
    inputSchema: {
      type: 'object',
      properties: {
        modelId: modelIdInput,
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'revision from model.parameters.read.',
        },
        changes: {
          type: 'object',
          minProperties: 1,
          description:
            'Parameter names and new values, null to remove, using the names that model.parameters.read returns.',
        },
      },
      required: ['modelId', 'expectedRevision', 'changes'],
      additionalProperties: false,
    },
  },
];

function supportedParameters(protocol: Connection['protocol']): ParameterKey[] {
  const keys = protocolOptionKeys(protocol);
  return PARAMETER_KEYS.filter((key) => key === 'maxOutputTokens' || keys.includes(key));
}

function view(store: Store, model: ModelPreset) {
  const connection = store.product.get<Connection>('connection', model.connectionId);
  const supported = supportedParameters(connection.protocol);
  return {
    modelId: model.id,
    title: model.title,
    revision: model.revision,
    providerModelId: model.modelId,
    protocol: connection.protocol,
    parameters: Object.fromEntries(
      supported.map((key) => [key, (model as Record<string, unknown>)[key] ?? null])
    ),
    supported,
  };
}

export function invokeHelperModelParameterTool(
  store: Store,
  name: string,
  value: unknown
): ReturnType<typeof view> & { changed?: boolean } {
  const args = record(value);
  fields(
    args,
    name === 'model.parameters.read' ? ['modelId'] : ['modelId', 'expectedRevision', 'changes']
  );
  const modelId = text(args.modelId, 'saved model ID', 100);
  store.product.assertAvailable('model', modelId);
  const model = store.product.get<ModelPreset>('model', modelId);
  if (name === 'model.parameters.read') return view(store, model);
  if (name !== 'model.parameters.update') throw new HttpError(400, 'UNKNOWN_MODEL_PARAMETER_TOOL');
  const expectedRevision = number(args.expectedRevision, 'model revision', 1);
  const changes = record(args.changes);
  const supported = view(store, model).supported as string[];
  const unsupported = Object.keys(changes).filter((key) => !supported.includes(key));
  if (!Object.keys(changes).length || unsupported.length)
    throw new HttpError(
      400,
      `MODEL_PARAMETER_UNSUPPORTED: ${unsupported.join(', ') || 'no change'}; this model accepts ${supported.join(', ')}.`
    );
  if (changes.maxOutputTokens === null)
    throw new HttpError(400, 'MODEL_PARAMETER_REQUIRED: maxOutputTokens cannot be removed.');
  const input: Record<string, unknown> = { expectedRevision };
  for (const key of SAVED_MODEL_KEYS) {
    const current = (model as Record<string, unknown>)[key];
    if (current !== undefined) input[key] = structuredClone(current);
  }
  for (const [key, next] of Object.entries(changes)) {
    if (next === null && key !== 'temperature') delete input[key];
    else input[key] = next;
  }
  let prepared: ReturnType<Store['product']['prepareModel']>;
  try {
    prepared = store.product.prepareModel(input, modelId);
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 409) throw error;
    throw new HttpError(
      400,
      `MODEL_PARAMETERS_INVALID: ${error instanceof Error ? error.message : 'Check the parameter values.'}`
    );
  }
  const saved = store.product.save(
    'model',
    prepared.value,
    modelId,
    prepared.expectedRevision
  ) as ModelPreset;
  return { ...view(store, saved), changed: saved.revision !== model.revision };
}
