import { expect, test } from 'vitest';
import type { Connection, Library, ModelPreset } from '../core/product.js';
import { modelCapability } from '../core/model-capabilities.js';
import { newStoryModelDefaults } from '../web/pendingStory.js';

const connection: Connection = {
  id: 'vertex',
  revision: 1,
  title: 'Synthetic Vertex connection',
  protocol: 'vertex-gemini-v1',
  endpoint:
    'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models',
  enabled: true,
  catalog: [],
  catalogError: null,
};
const model: ModelPreset = {
  id: 'gemini-main',
  revision: 1,
  title: 'Synthetic Gemini model',
  connectionId: connection.id,
  modelId: 'gemini-3.8-flash',
  capabilityProtocol: connection.protocol,
  capabilityRevision: modelCapability(connection.protocol, 'gemini-3.8-flash')!.revision,
  maxOutputTokens: 4000,
  temperature: null,
  thinkingLevel: 'HIGH',
};
const library = (
  models: ModelPreset[] = [model],
  connections: Connection[] = [connection]
): Pick<Library, 'models' | 'connections'> => ({ models, connections });

test('a sole compatible model starts the main role without enabling an unrequested translation model', () => {
  expect(newStoryModelDefaults(library(), null)).toEqual({
    main: model.id,
    translation: '',
    mainReason: 'only',
    eligibleIds: [model.id],
  });
});

test('a recent valid choice wins while absent or malformed history never picks arbitrarily among models', () => {
  const second = { ...model, id: 'gemini-other' };
  const current = library([model, second]);
  expect(newStoryModelDefaults(current, { main: second.id, translation: model.id })).toMatchObject({
    main: second.id,
    translation: model.id,
    mainReason: 'recent',
  });
  for (const saved of [null, [], 'invalid', { main: 'deleted' }, { main: [model.id] }])
    expect(newStoryModelDefaults(current, saved)).toMatchObject({
      main: '',
      translation: '',
      mainReason: null,
    });
});

test('remembered disabled, missing-connection, changed-protocol and incompatible models are never suggested', () => {
  const invalid: Pick<Library, 'models' | 'connections'>[] = [
    library([{ ...model, enabled: false }]),
    library([model], [{ ...connection, enabled: false }]),
    library([model], []),
    library([{ ...model, capabilityProtocol: 'openai-chat-v1' }]),
    library([{ ...model, capabilityRevision: undefined }]),
    library([{ ...model, capabilityRevision: 'stale-capability' }]),
    library([{ ...model, structuredOutput: true }]),
    library([{ ...model, maxOutputTokens: 1_000_000 }]),
  ];
  for (const current of invalid)
    expect(newStoryModelDefaults(current, { main: model.id, translation: model.id })).toEqual({
      main: '',
      translation: '',
      mainReason: null,
      eligibleIds: [],
    });
});

test('official unknown model IDs are excluded while custom-endpoint and fixture model contracts remain usable', () => {
  const unknown: ModelPreset = {
    ...model,
    modelId: 'synthetic-private-model',
    capabilityRevision: undefined,
    thinkingLevel: undefined,
  };
  expect(newStoryModelDefaults(library([unknown]), { main: unknown.id }).main).toBe('');
  const custom: Connection = {
    ...connection,
    protocol: 'openai-chat-v1',
    endpoint: 'http://127.0.0.1:9/v1',
  };
  const customModel = { ...unknown, capabilityProtocol: custom.protocol };
  expect(newStoryModelDefaults(library([customModel], [custom]), null).main).toBe(model.id);
  expect(
    newStoryModelDefaults(
      library([customModel], [{ ...custom, endpoint: 'https://api.openai.com/v1' }]),
      null
    ).main
  ).toBe('');
  const fixture: Connection = { ...custom, protocol: 'fixture-sse-v1' };
  expect(
    newStoryModelDefaults(
      library([{ ...unknown, capabilityProtocol: fixture.protocol }], [fixture]),
      null
    ).main
  ).toBe(model.id);
});

test('invalid history falls back only to the remaining compatible main model', () => {
  const disabled = { ...model, id: 'old-disabled', enabled: false };
  expect(
    newStoryModelDefaults(library([disabled, model]), {
      main: disabled.id,
      translation: disabled.id,
    })
  ).toMatchObject({ main: model.id, translation: '', mainReason: 'only' });
});
