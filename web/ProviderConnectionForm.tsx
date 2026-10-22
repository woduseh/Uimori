import { t, useI18n, translateMessage } from './i18n.js';
import type { ReactNode, RefObject, Dispatch, SetStateAction } from 'react';
import { NoticeBanner } from './NoticeBanner.js';
import type { Connection, ProviderProtocol } from '../core/product.js';
import { PROVIDER_DEFINITIONS, providerDefinition } from '../core/provider-definitions.js';
import { Switch } from './BooleanControls.js';
import { VertexCredentialUpload } from './VertexCredentialUpload.js';
import type { ProviderEditorState, ConnectionDraft } from './provider-editor-state.js';

function vertexEndpoint(projectId: string): string {
  return `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models`;
}

type Props = {
  hidden: boolean;
  testMode: boolean;
  draft: ProviderEditorState['connection'];
  connections: Connection[];
  conflict: boolean;
  busy: boolean;
  operationBusy: boolean;
  formRef: RefObject<HTMLFormElement | null>;
  onChange: Dispatch<SetStateAction<ConnectionDraft>>;
  onUploadBusy: (busy: boolean) => void;
  onSubmit: () => Promise<boolean>;
  onReload: () => void;
  onDone: () => void;
  deleteAction: ReactNode;
};
export function ProviderConnectionForm({
  hidden,
  testMode,
  draft,
  connections,
  conflict,
  busy,
  operationBusy,
  formRef,
  onChange,
  onUploadBusy,
  onSubmit,
  onReload,
  onDone,
  deleteAction,
}: Props) {
  useI18n();
  const {
    value: connection,
    editing: editingConnection,
    copy: connectionCopy,
    baseline: connectionBaseline,
  } = draft;
  const codex = connection.protocol === 'codex-app-server-v1';
  const vertex = connection.protocol === 'vertex-gemini-v1';
  const vertexProjectId =
    connection.endpoint.match(/\/projects\/([^/]+)\/locations\/global\//)?.[1] ?? '';
  const definition = providerDefinition(connection.protocol);
  const endpointLabel = codex
    ? t('providers.m126')
    : vertex
      ? t('providers.m127')
      : connection.protocol === 'fixture-sse-v1'
        ? t('providers.m128')
        : t('providers.m129');
  return (
    <form
      hidden={hidden}
      ref={formRef}
      className="editor-grid provider-management-form"
      aria-label={t('providers.m130')}
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <h3 className="full">
        {editingConnection
          ? t('providers.m131')
          : connectionCopy
            ? t('providers.m132')
            : t('providers.m133')}
        {(!editingConnection || JSON.stringify(connection) !== connectionBaseline) && (
          <small className="provider-heading-status">
            {editingConnection ? t('settings.unsavedItem') : t('settings.newItem')}
          </small>
        )}
      </h3>
      {editingConnection && <p className="provider-draft-note full">{t('providers.m134')}</p>}
      {editingConnection &&
        (conflict ||
          connections.find((item) => item.id === editingConnection.id)?.revision !==
            editingConnection.revision) && (
          <div className="provider-draft-note full">
            {connections.find((item) => item.id === editingConnection.id)?.revision !==
              editingConnection.revision && <p>{t('providers.m135')}</p>}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                onReload();
              }}
            >
              {t('providers.m136')}
            </button>
          </div>
        )}
      {connectionCopy && <p className="provider-draft-note full">{t('providers.m137')}</p>}
      {conflict && (
        <NoticeBanner tone="error" className="full">
          {t('providers.m138')}
        </NoticeBanner>
      )}
      <fieldset className="editor-fields full provider-connection-fields" disabled={busy}>
        <label>
          {t('providers.m139')}
          <select
            aria-label={t('providers.m140')}
            value={connection.protocol}
            onChange={(event) => {
              const protocol = event.target.value as ProviderProtocol,
                definition = providerDefinition(protocol);
              onChange({
                ...connection,
                protocol,
                endpoint: definition.endpointDefault,
                credentialRef: '',
                apiKey: undefined,
              });
            }}
          >
            {PROVIDER_DEFINITIONS.filter(
              (item) => testMode || item.id !== 'fixture-sse-v1' || connection.protocol === item.id
            ).map((item) => (
              <option key={item.id} value={item.id}>
                {translateMessage(item.label)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('providers.m43')}
          <input
            aria-label={t('providers.m43')}
            required
            maxLength={160}
            value={connection.title}
            onChange={(event) => onChange({ ...connection, title: event.target.value })}
          />
        </label>
        {vertex && (
          <VertexCredentialUpload
            credentialRef={connection.credentialRef}
            disabled={operationBusy}
            onBusy={onUploadBusy}
            onRegistered={(value) =>
              onChange((current) => ({
                ...current,
                credentialRef: value.credentialRef,
                endpoint: vertexEndpoint(value.projectId),
              }))
            }
          />
        )}
        {vertex && (
          <label className="full">
            {t('providers.m141')}
            <input
              aria-label={t('providers.m141')}
              placeholder="my-project"
              value={vertexProjectId}
              onChange={(event) =>
                onChange({
                  ...connection,
                  endpoint: event.target.value.trim()
                    ? vertexEndpoint(event.target.value.trim())
                    : '',
                })
              }
            />
          </label>
        )}
        <label className="full">
          {endpointLabel}
          <input
            aria-label={endpointLabel}
            type="url"
            required
            readOnly={codex}
            placeholder={
              vertex
                ? 'https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/publishers/google/models'
                : connection.protocol === 'fixture-sse-v1'
                  ? t('providers.m143')
                  : 'https://provider.example/v1'
            }
            value={connection.endpoint}
            onChange={(event) => onChange({ ...connection, endpoint: event.target.value })}
          />
          {vertex && vertexProjectId && connection.endpoint === vertexEndpoint(vertexProjectId) && (
            <small>{t('settings.vertexEndpoint')}</small>
          )}
        </label>
        {!codex && !vertex && (
          <label className="full">
            {t('providers.m144')}
            <input
              aria-label={t('providers.m144')}
              type="password"
              autoComplete="new-password"
              placeholder={
                connection.credentialRef
                  ? t('providers.m145')
                  : connection.protocol === 'google-gemini-v1'
                    ? t('providers.m146')
                    : t('providers.m147')
              }
              value={connection.apiKey ?? ''}
              onChange={(event) => onChange({ ...connection, apiKey: event.target.value })}
            />
            {connection.credentialRef && (
              <button
                type="button"
                className="ghost"
                onClick={() => onChange({ ...connection, apiKey: null, credentialRef: '' })}
              >
                {t('providers.m148')}
              </button>
            )}
          </label>
        )}
        <label className="check">
          <Switch
            checked={connection.enabled}
            onChange={(event) => onChange({ ...connection, enabled: event.target.checked })}
          />
          {t('providers.m149')}
        </label>
        <small className="full">
          {codex ? t('providers.m150') : vertex ? t('providers.m151') : t('providers.m152')}
        </small>
        <details className="provider-definition full">
          <summary>{t('providers.m153')}</summary>
          <dl>
            <dt>{t('providers.m154')}</dt>
            <dd>{definition.auth}</dd>
            <dt>{t('providers.m155')}</dt>
            <dd>{definition.catalog === 'remote' ? t('providers.m156') : t('providers.m157')}</dd>
          </dl>
          <ul>
            {definition.limitations.map((item) => (
              <li key={item}>{translateMessage(item)}</li>
            ))}
          </ul>
          <p>{t('providers.m158')}</p>
        </details>
      </fieldset>
      <div className="provider-actions full provider-save-actions">
        {editingConnection && deleteAction}
        <button type="button" className="secondary" disabled={busy} onClick={() => onDone()}>
          {t('providers.m162')}
        </button>
        <button className="primary" disabled={busy}>
          {editingConnection ? t('providers.m163') : t('providers.m133')}
        </button>
      </div>
    </form>
  );
}
