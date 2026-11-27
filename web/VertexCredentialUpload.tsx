import { readJsonFile } from './json-input.js';
import { t, useI18n } from './i18n.js';
import { UiError, uiMessage, type UiMessage } from './ui-message.js';
import { useEffect, useRef, useState } from 'react';
import { NoticeBanner } from './NoticeBanner.js';
import { CredentialFileIcon, UploadIcon } from './ui-icons.js';
import { providerEndpoints } from '#contracts';
import { ApiError, callEndpoint } from './api.js';
import { toUiMessage } from './api-errors.js';
import type { VertexAccountDraft } from './provider-editor-state.js';

export function VertexCredentialUpload({
  credentialRef,
  account,
  disabled,
  onRegistered,
  onBusy,
}: {
  credentialRef: string;
  account?: VertexAccountDraft;
  disabled: boolean;
  onRegistered: (credential: VertexAccountDraft) => void;
  onBusy: (value: boolean) => void;
}) {
  useI18n();
  const [uploading, setUploading] = useState(false),
    [error, setError] = useState<UiMessage | null>(null);
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    []
  );
  const selected = Boolean(account) || credentialRef.startsWith('UIMORI_PROVIDER_VERTEX_FILE_');
  return (
    <section className="vertex-credential-upload full" aria-label={t('providers.m392')}>
      <div className="provider-section-heading">
        <strong>
          <CredentialFileIcon size={18} aria-hidden="true" />
          {t('providers.m393')}
        </strong>
        {selected && <span className="provider-status">{t('providers.m394')}</span>}
      </div>
      <label className="vertex-upload-field">
        <span>
          <UploadIcon size={16} aria-hidden="true" />
          {uploading ? t('providers.m396') : selected ? t('providers.m397') : t('providers.m398')}
        </span>
        <input
          type="file"
          aria-label={t('providers.m399')}
          accept=".json,application/json"
          disabled={disabled || uploading}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            setError(null);
            if (file.size > 64 * 1024) {
              setError(uiMessage('providers.m400'));
              return;
            }
            const current = ++epoch.current;
            setUploading(true);
            onBusy(true);
            try {
              const serviceAccount = await readJsonFile(file, 'providers.m401');
              if (
                !serviceAccount ||
                typeof serviceAccount !== 'object' ||
                Array.isArray(serviceAccount) ||
                (serviceAccount as Record<string, unknown>).type !== 'service_account'
              )
                throw new UiError(uiMessage('providers.m402'));
              const value = await callEndpoint(providerEndpoints.validateVertexCredential, {
                serviceAccount,
              });
              if (current !== epoch.current) return;
              onRegistered({ ...value, serviceAccount });
            } catch (caught) {
              if (current === epoch.current)
                setError(
                  caught instanceof ApiError && caught.status === 400
                    ? uiMessage('providers.m403')
                    : toUiMessage(caught, 'providers.m404')
                );
            } finally {
              if (current === epoch.current) {
                setUploading(false);
                onBusy(false);
              }
            }
          }}
        />
      </label>
      {account && (
        <p role="status">
          {t('providers.m582', { value0: account.projectId })}
          <br />
          <small>{account.clientEmail}</small>
        </p>
      )}
      {error && <NoticeBanner tone="error">{error}</NoticeBanner>}
    </section>
  );
}
