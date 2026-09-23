import type { SetStateAction } from 'react';
import type { Connection, ModelPreset, ProviderProtocol } from '../core/product.js';
import { initialModel, type ModelDraft } from './provider-model-draft.js';

export type ConnectionDraft = {
  title: string;
  protocol: ProviderProtocol;
  endpoint: string;
  credentialRef: string;
  apiKey?: string | null;
  enabled: boolean;
};
export const initialConnection = (): ConnectionDraft => ({
  title: '',
  protocol: 'fixture-sse-v1',
  endpoint: '',
  credentialRef: '',
  enabled: false,
});
export const connectionDraft = (item: Connection): ConnectionDraft => ({
  title: item.title,
  protocol: item.protocol,
  endpoint: item.endpoint,
  credentialRef: item.credentialRef ?? '',
  enabled: item.enabled,
});
export function connectionPayload(value: ConnectionDraft) {
  return {
    title: value.title,
    protocol: value.protocol,
    endpoint: value.protocol === 'codex-app-server-v1' ? 'codex://local' : value.endpoint,
    ...(value.protocol !== 'codex-app-server-v1' && value.credentialRef.trim()
      ? { credentialRef: value.credentialRef.trim() }
      : {}),
    ...(value.apiKey !== undefined ? { apiKey: value.apiKey } : {}),
    enabled: value.enabled,
  };
}
type Draft<Value, Saved> = {
  value: Value;
  baseline: string;
  editing?: Saved;
  copy: boolean;
  started: boolean;
};
export type ProviderEditorState = {
  connection: Draft<ConnectionDraft, Connection>;
  model: Draft<ModelDraft, ModelPreset>;
  conflict: 'connection' | 'model' | null;
};
function open<Value, Saved>(
  value: Value,
  editing?: Saved,
  copy = false,
  started = true
): Draft<Value, Saved> {
  return {
    value,
    baseline: JSON.stringify(value),
    editing: editing && structuredClone(editing),
    copy,
    started,
  };
}
export const initialProviderEditorState = (): ProviderEditorState => ({
  connection: open<ConnectionDraft, Connection>(initialConnection(), undefined, false, false),
  model: open<ModelDraft, ModelPreset>(initialModel(), undefined, false, false),
  conflict: null,
});
type Action =
  | { type: 'connection.open'; value: ConnectionDraft; editing?: Connection; copy?: boolean }
  | { type: 'model.open'; value: ModelDraft; editing?: ModelPreset; copy?: boolean }
  | { type: 'connection.change'; update: SetStateAction<ConnectionDraft> }
  | { type: 'model.change'; update: SetStateAction<ModelDraft> }
  | { type: 'connection.deleted'; id: string }
  | { type: 'model.deleted'; id: string }
  | { type: 'conflict'; kind: ProviderEditorState['conflict'] };

/** Two independent in-memory drafts. Navigation never discards either one or persists API keys. */
export function providerEditorReducer(
  state: ProviderEditorState,
  action: Action
): ProviderEditorState {
  switch (action.type) {
    case 'connection.open':
      return {
        ...state,
        connection: open(action.value, action.editing, action.copy),
        conflict: null,
      };
    case 'model.open':
      return { ...state, model: open(action.value, action.editing, action.copy), conflict: null };
    case 'connection.change': {
      const value =
        typeof action.update === 'function' ? action.update(state.connection.value) : action.update;
      return value === state.connection.value
        ? state
        : { ...state, connection: { ...state.connection, value } };
    }
    case 'model.change': {
      const value =
        typeof action.update === 'function' ? action.update(state.model.value) : action.update;
      return value === state.model.value ? state : { ...state, model: { ...state.model, value } };
    }
    case 'connection.deleted':
      return {
        ...state,
        conflict: null,
        connection:
          state.connection.editing?.id === action.id
            ? open<ConnectionDraft, Connection>(initialConnection(), undefined, false, false)
            : state.connection,
        model:
          state.model.value.connectionRef === action.id
            ? {
                ...state.model,
                value: { ...state.model.value, connectionRef: '' },
                baseline: JSON.stringify({
                  ...JSON.parse(state.model.baseline),
                  connectionRef: '',
                }),
              }
            : state.model,
      };
    case 'model.deleted':
      return {
        ...state,
        conflict: null,
        model:
          state.model.editing?.id === action.id
            ? open<ModelDraft, ModelPreset>(initialModel(), undefined, false, false)
            : state.model,
      };
    case 'conflict':
      return state.conflict === action.kind ? state : { ...state, conflict: action.kind };
  }
}
