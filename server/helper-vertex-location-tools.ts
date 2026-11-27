import { createHash } from 'node:crypto';
import type { Json, ProviderTool } from '../core/transport.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { ProviderConnectionTest } from '../core/provider-connection-test.js';
import {
  isVertexLocation,
  parseVertexEndpoint,
  VERTEX_LOCATION_CHOICES,
  vertexModelsEndpoint,
} from '../core/vertex-location.js';
import {
  CONNECTION_TEST_TIMEOUT_MS,
  type ConnectionTestRunner,
} from './provider-connection-test.js';
import { HelperToolError } from './app-errors.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

const schema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const location: Json = {
  type: 'string',
  minLength: 2,
  maxLength: 40,
  description: `Vertex location: global, the us or eu multi-region, or a region such as us-central1. Offered choices: ${VERTEX_LOCATION_CHOICES.join(', ')}.`,
};

export const HELPER_VERTEX_LOCATION_TOOLS: ProviderTool[] = [
  {
    name: 'vertex.location.read',
    description:
      'List the Google Vertex AI connections with the location (region) each one sends requests to, its revision for vertex.location.update, and the saved models that use it. A location belongs to the connection, so changing it moves every model of that connection. Credentials, project IDs and endpoints are not included.',
    inputSchema: schema({}),
  },
  {
    name: 'vertex.location.compare',
    description:
      'Send one short billed test request for a saved Vertex model to each location (region) at the same time and report how each answered: responded with its latency, not_offered (the model is not served there), busy (429), unavailable (503), timeout (no answer in 25 seconds) or error. Use it when the user asks which location is fastest or why a model is slow or failing; each location costs one small request, so do not repeat it without a reason. The saved connection is not changed.',
    inputSchema: schema(
      {
        modelId: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'Saved model id, from vertex.location.read or model.list.',
        },
        locations: {
          type: 'array',
          minItems: 1,
          maxItems: VERTEX_LOCATION_CHOICES.length,
          uniqueItems: true,
          items: location,
          description: 'Locations to compare. Omit to compare every offered choice.',
        },
      },
      ['modelId']
    ),
  },
  {
    name: 'vertex.location.update',
    description:
      'Move one Vertex connection to another location (region). Every model of the connection uses the new location from its next request; requests already running keep theirs. Check with vertex.location.compare that the models in use are offered there, and change only when the user asked for it. Requires the connection revision from vertex.location.read.',
    inputSchema: schema(
      {
        connectionId: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'Vertex connection id, from vertex.location.read.',
        },
        location,
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'Connection revision from vertex.location.read.',
        },
      },
      ['connectionId', 'location', 'expectedRevision']
    ),
  },
];

export const isVertexLocationTool = (name: string) =>
  HELPER_VERTEX_LOCATION_TOOLS.some((tool) => tool.name === name);

function vertexEndpoint(connection: Connection) {
  const endpoint =
    connection.protocol === 'vertex-gemini-v1' ? parseVertexEndpoint(connection.endpoint) : null;
  if (!endpoint) throw new HelperToolError(400, 'VERTEX_CONNECTION_REQUIRED');
  return endpoint;
}

export function readVertexLocations(store: Store, value: unknown) {
  fields(record(value), []);
  const models = store.product.all('model') as ModelPreset[];
  return {
    choices: [...VERTEX_LOCATION_CHOICES],
    connections: (store.product.all('connection') as Connection[]).flatMap((connection) => {
      if (connection.protocol !== 'vertex-gemini-v1') return [];
      const endpoint = parseVertexEndpoint(connection.endpoint);
      if (!endpoint) return [];
      return [
        {
          connectionId: connection.id,
          title: connection.title,
          revision: connection.revision,
          enabled: connection.enabled,
          location: endpoint.location,
          models: models
            .filter((model) => model.connectionId === connection.id)
            .map((model) => ({
              modelId: model.id,
              title: model.title,
              providerModelId: model.modelId,
              enabled: model.enabled !== false,
            })),
        },
      ];
    }),
  };
}

type Outcome = 'responded' | 'not_offered' | 'busy' | 'unavailable' | 'timeout' | 'error';
function outcome(test: ProviderConnectionTest): Outcome {
  if (test.status === 'completed') return 'responded';
  if (test.error === 'HTTP_404') return 'not_offered';
  if (test.error === 'HTTP_429') return 'busy';
  if (test.error === 'HTTP_503') return 'unavailable';
  if (test.error === 'TIMEOUT') return 'timeout';
  return 'error';
}

async function settled(
  runner: ConnectionTestRunner,
  view: ProviderConnectionTest,
  signal: AbortSignal
): Promise<ProviderConnectionTest> {
  const deadline = Date.now() + CONNECTION_TEST_TIMEOUT_MS + 5_000;
  let current = view;
  while (current.status === 'running' && Date.now() < deadline) {
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = runner.get(view.id);
  }
  return current;
}

export async function compareVertexLocations(
  store: Store,
  runner: ConnectionTestRunner,
  value: unknown,
  operationKey: string,
  stillAuthorized: () => void,
  signal: AbortSignal
) {
  const args = record(value);
  fields(args, ['modelId', 'locations']);
  const modelId = text(args.modelId, 'saved model ID', 100);
  const model = store.product.available<ModelPreset>('model', modelId);
  const connection = store.product.available<Connection>('connection', model.connectionId);
  const endpoint = vertexEndpoint(connection);
  let locations: string[] = [...VERTEX_LOCATION_CHOICES];
  if (args.locations !== undefined) {
    if (
      !Array.isArray(args.locations) ||
      args.locations.length < 1 ||
      args.locations.length > VERTEX_LOCATION_CHOICES.length
    )
      throw new HelperToolError(400, 'INVALID_VERTEX_LOCATIONS');
    locations = args.locations.map((item) => text(item, 'location', 40));
    if (new Set(locations).size !== locations.length || !locations.every(isVertexLocation))
      throw new HelperToolError(400, 'INVALID_VERTEX_LOCATIONS');
  }
  const key = createHash('sha256').update(operationKey).digest('hex').slice(0, 32);
  const results = await Promise.all(
    locations.map(async (location) => {
      try {
        const started = runner.start(
          {
            id: model.id,
            expectedRevision: model.revision,
            idempotencyKey: `helper-location:${key}:${location}`,
            location,
          },
          stillAuthorized
        );
        await started.done;
        const test = await settled(runner, runner.get(started.view.id), signal);
        return {
          location,
          outcome: test.status === 'running' ? ('timeout' as const) : outcome(test),
          latencyMs: test.status === 'completed' ? test.latencyMs : null,
          error: test.status === 'completed' ? null : test.error,
        };
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          location,
          outcome: 'error' as const,
          latencyMs: null,
          error: error instanceof HttpError ? error.message : 'CONNECTION_TEST_FAILED',
        };
      }
    })
  );
  const responded = results.filter(
    (result): result is typeof result & { latencyMs: number } =>
      result.outcome === 'responded' && result.latencyMs !== null
  );
  return {
    modelId: model.id,
    title: model.title,
    providerModelId: model.modelId,
    connectionId: connection.id,
    connectionRevision: connection.revision,
    currentLocation: endpoint.location,
    fastest: responded.length
      ? responded.reduce((best, result) => (result.latencyMs < best.latencyMs ? result : best))
          .location
      : null,
    results,
  };
}

export function updateVertexLocation(store: Store, value: unknown) {
  const args = record(value);
  fields(args, ['connectionId', 'location', 'expectedRevision']);
  const connectionId = text(args.connectionId, 'connection ID', 100);
  const location = text(args.location, 'location', 40);
  const expectedRevision = number(args.expectedRevision, 'connection revision', 1);
  const connection = store.product.editable<Connection>(
    'connection',
    connectionId,
    expectedRevision
  );
  const endpoint = vertexEndpoint(connection);
  if (!isVertexLocation(location)) throw new HelperToolError(400, 'INVALID_VERTEX_LOCATION');
  const saved =
    endpoint.location === location
      ? connection
      : (store.product.connection(
          {
            title: connection.title,
            protocol: connection.protocol,
            endpoint: vertexModelsEndpoint(endpoint.projectId, location),
            ...(connection.credentialRef ? { credentialRef: connection.credentialRef } : {}),
            enabled: connection.enabled,
            expectedRevision,
          },
          connectionId
        ) as Connection);
  return {
    connectionId: saved.id,
    title: saved.title,
    revision: saved.revision,
    previousLocation: endpoint.location,
    location,
  };
}
