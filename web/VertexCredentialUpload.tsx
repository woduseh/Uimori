import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import { NoticeBanner } from './NoticeBanner.js';
import { CredentialFileIcon, UploadIcon } from './ui-icons.js';
import { api, ApiError } from './api.js';

type RegisteredCredential = { credentialRef: string; projectId: string; clientEmail: string };
export function VertexCredentialUpload({
  credentialRef,
  disabled,
  onRegistered,
  onBusy,
}: {
  credentialRef: string;
  disabled: boolean;
  onRegistered: (credential: RegisteredCredential) => void;
  onBusy: (value: boolean) => void;
}) {
  useI18n();
  const [uploading, setUploading] = useState(false),
    [error, setError] = useState('');
  const [registered, setRegistered] = useState<RegisteredCredential>();
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    []
  );
  const stored = credentialRef.startsWith('UIMORI_PROVIDER_VERTEX_FILE_');
  return (
    <section className="vertex-credential-upload full" aria-label={t('providers.m392')}>
      <div className="provider-section-heading">
        <strong>
          <CredentialFileIcon size={18} aria-hidden="true" />
          {t('providers.m393')}
        </strong>
        {stored && <span className="provider-status">{t('providers.m394')}</span>}
      </div>
      <label className="vertex-upload-field">
        <span>
          <UploadIcon size={16} aria-hidden="true" />
          {uploading ? t('providers.m396') : stored ? t('providers.m397') : t('providers.m398')}
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
            setError('');
            if (file.size > 64 * 1024) {
              setError(uiMessage('providers.m400'));
              return;
            }
            const current = ++epoch.current;
            setUploading(true);
            onBusy(true);
            try {
              let serviceAccount: unknown;
              try {
                serviceAccount = JSON.parse(await file.text());
              } catch {
                throw new Error(uiMessage('providers.m401'));
              }
              if (
                !serviceAccount ||
                typeof serviceAccount !== 'object' ||
                Array.isArray(serviceAccount) ||
                (serviceAccount as Record<string, unknown>).type !== 'service_account'
              )
                throw new Error(uiMessage('providers.m402'));
              const value = await api<RegisteredCredential>(
                '/provider-management/vertex-credentials',
                { serviceAccount }
              );
              if (current !== epoch.current) return;
              setRegistered(value);
              onRegistered(value);
            } catch (caught) {
              if (current === epoch.current)
                setError(
                  caught instanceof ApiError && caught.status === 400
                    ? uiMessage('providers.m403')
                    : caught instanceof Error
                      ? caught.message
                      : uiMessage('providers.m404')
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
      {stored && registered?.credentialRef === credentialRef && (
        <p role="status">
          {t('providers.m582', { value0: registered.projectId })}
          <br />
          <small>{registered.clientEmail}</small>
        </p>
      )}
      {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
    </section>
  );
}
