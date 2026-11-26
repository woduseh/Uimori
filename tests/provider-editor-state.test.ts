import { expect, test } from 'vitest';
import type { Connection } from '../core/product.js';
import { initialModel } from '../web/provider-model-draft.js';
import {
  connectionDraft,
  connectionPayload,
  initialProviderEditorState,
  providerEditorReducer,
} from '../web/provider-editor-state.js';

const connection: Connection = {
  id: 'provider',
  revision: 2,
  title: 'Synthetic',
  protocol: 'openai-chat-v1',
  endpoint: 'https://provider.example/v1',
  enabled: true,
  catalog: [],
  catalogError: null,
};

test('deleting a provider resets its editor and repairs the model reference without discarding unrelated edits', () => {
  let state = initialProviderEditorState();
  state = providerEditorReducer(state, {
    type: 'connection.open',
    value: connectionDraft(connection),
    editing: connection,
  });
  state = providerEditorReducer(state, {
    type: 'model.open',
    value: { ...initialModel(), connectionRef: connection.id },
  });
  state = providerEditorReducer(state, {
    type: 'model.change',
    update: (value) => ({ ...value, title: 'Unsaved title' }),
  });
  state = providerEditorReducer(state, { type: 'connection.deleted', id: connection.id });
  expect(state.connection.started).toBe(false);
  expect(state.connection.editing).toBeUndefined();
  expect(state.model.value).toMatchObject({ connectionRef: '', title: 'Unsaved title' });
  expect(JSON.parse(state.model.baseline).connectionRef).toBe('');
  expect(JSON.stringify(state.model.value)).not.toBe(state.model.baseline);
});

test('connection copy and key removal payloads preserve the existing explicit semantics', () => {
  const state = providerEditorReducer(initialProviderEditorState(), {
    type: 'connection.open',
    value: { ...connectionDraft(connection), enabled: false },
    copy: true,
  });
  expect(state.connection).toMatchObject({ copy: true, started: true, editing: undefined });
  expect(connectionPayload({ ...state.connection.value, apiKey: null })).toMatchObject({
    apiKey: null,
    enabled: false,
  });
  expect(connectionPayload(state.connection.value)).not.toHaveProperty('apiKey');
});
