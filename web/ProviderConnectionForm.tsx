import { t, useI18n } from './i18n.js';
import type { ReactNode, RefObject, Dispatch, SetStateAction } from 'react';
import { NoticeBanner } from './NoticeBanner.js';
import type { LibraryConnection, ProviderProtocol } from '../core/product.js';
import { PROVIDER_DEFINITIONS, providerDefinition } from '../core/provider-definitions.js';
import { providerLabel, providerLimitations } from './builtin-labels.js';
import { ToggleRow } from './ToggleRow.js';
import { SaveButton } from './SaveButton.js';
import { IconButton } from './IconButton.js';
import { CloseIcon } from './ui-icons.js';
import { VertexCredentialUpload } from './VertexCredentialUpload.js';
import type { ProviderEditorState, ConnectionDraft } from './provider-editor-state.js';
import {
  parseVertexEndpoint,
  vertexLocationOptions,
  vertexModelsEndpoint,
} from '../core/vertex-location.js';
import { vertexLocationLabel } from './vertex-location-label.js';

function vertexParts(endpoint: string) {
  const parsed = parseVertexEndpoint(endpoint);
  return {
    projectId: parsed?.projectId ?? endpoint.match(/\/projects\/([^/]+)\//u)?.[1] ?? '',
    location: parsed?.location ?? endpoint.match(/\/locations\/([^/]+)\//u)?.[1] ?? 'global',
  };
}

type Props = {
  hidden: boolean;
  testMode: boolean;
  draft: ProviderEditorState['connection'];
  connections: LibraryConnection[];
  conflict: boolean;
  busy: boolean;
  saving: boolean;
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
  saving,
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

    baseline: connectionBaseline,
  } = draft;
  const codex = connection.protocol === 'codex-app-server-v1';
  const vertex = connection.protocol === 'vertex-gemini-v1';
  const { projectId: vertexProjectId, location: vertexLocation } = vertexParts(connection.endpoint);
  const endpointLabel = codex
    ? t('providers.m126')
    : vertex
      ? t('providers.m127')
      : connection.protocol === 'fixture-sse-v1'
        ? t('providers.m128')
        : t('providers.m129');
  const staleConnection =
    !!editingConnection &&
    connections.find((item) => item.id === editingConnection.id)?.revision !==
      editingConnection.revision;
  const reloadButton = editingConnection && (
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
  );
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
      {editingConnection && (
        <h3 className="full">
          {t('providers.m131')}
          {JSON.stringify(connection) !== connectionBaseline && (
            <small className="provider-heading-status">{t('settings.unsavedItem')}</small>
          )}
        </h3>
      )}
      {conflict ? (
        <NoticeBanner tone="error" className="full" actions={reloadButton}>
          {t('providers.m138')}
        </NoticeBanner>
      ) : (
        staleConnection && (
          <div className="provider-draft-note full">
            <p>{t('providers.m135')}</p>
            {reloadButton}
          </div>
        )
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
                vertexAccount: undefined,
              });
            }}
          >
            {PROVIDER_DEFINITIONS.filter(
              (item) => testMode || item.id !== 'fixture-sse-v1' || connection.protocol === item.id
            ).map((item) => (
              <option key={item.id} value={item.id}>
                {providerLabel(item.id)}
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
            account={connection.vertexAccount}
            disabled={operationBusy}
            onBusy={onUploadBusy}
            onRegistered={(value) =>
              onChange((current) => ({
                ...current,
                credentialRef: '',
                apiKey: undefined,
                vertexAccount: value,
                endpoint: vertexModelsEndpoint(
                  value.projectId,
                  vertexParts(current.endpoint).location
                ),
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
                    ? vertexModelsEndpoint(event.target.value.trim(), vertexLocation)
                    : '',
                })
              }
            />
          </label>
        )}
        {vertex && (
          <label className="full">
            {t('providers.vertexLocation')}
            <select
              aria-label={t('providers.vertexLocation')}
              disabled={!vertexProjectId}
              value={vertexLocation}
              onChange={(event) =>
                onChange({
                  ...connection,
                  endpoint: vertexModelsEndpoint(vertexProjectId, event.target.value),
                })
              }
            >
              {vertexLocationOptions(vertexLocation).map((location) => (
                <option key={location} value={location}>
                  {vertexLocationLabel(location)}
                </option>
              ))}
            </select>
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
        <ToggleRow
          label={t('providers.m149')}
          checked={connection.enabled}
          onChange={(enabled) => onChange({ ...connection, enabled })}
        />
        <details className="provider-definition full">
          <summary>{t('providers.m153')}</summary>
          <ul>
            {providerLimitations(connection.protocol).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      </fieldset>
      <div className="provider-actions full provider-save-actions">
        {editingConnection && deleteAction}
        <IconButton
          icon={CloseIcon}
          label={t('providers.m162')}
          disabled={busy}
          onClick={() => onDone()}
        />
        <SaveButton
          label={editingConnection ? t('providers.m163') : t('providers.m133')}
          text={editingConnection ? t('shared.save') : t('library.register')}
          disabled={busy}
          aria-busy={saving}
        />
      </div>
    </form>
  );
}
