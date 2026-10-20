import { t, useI18n, message as retainedMessage } from './i18n.js';
import { ResourceExportButton } from './ResourceExportButton.js';
import { useEffect, useRef, useState } from 'react';
import { DownloadIcon } from './ui-icons.js';
import { sessionRequiredEvent } from './api.js';

const exportMessages = (): Record<string, string> => ({
  RISU_EXPORT_MODULE_UNSUPPORTED: retainedMessage('transfer.m087'),
  RISU_EXPORT_MODULE_CONFLICT: retainedMessage('transfer.m088'),
  RISU_EXPORT_ASSET_UNAVAILABLE: retainedMessage('transfer.m089'),
  RISU_EXPORT_ASSET_PATH: retainedMessage('transfer.m090'),
  RISU_EXPORT_TOO_LARGE: retainedMessage('transfer.m091'),
  RISU_EXPORT_REVISION_CHANGED: retainedMessage('transfer.m092'),
});

export function RisuExportButton({
  kind,
  format: requestedFormat,
  id,
  revision,
  title,
  disabled,
  linkedModules = false,
  onError,
}: {
  kind: 'content' | 'prompt-presets';
  format?: 'CHARX' | 'RISUM';
  id: string;
  revision: number;
  title: string;
  disabled?: boolean;
  linkedModules?: boolean;
  onError: (message: string) => void;
}) {
  useI18n();
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const format = kind === 'content' ? (requestedFormat ?? 'CHARX') : 'RISUP';
  return (
    <>
      <ResourceExportButton
        kind={kind === 'content' ? 'content' : 'prompt-preset'}
        id={id}
        disabled={disabled || busy}
        onError={onError}
      />
      <button
        type="button"
        className="secondary"
        disabled={disabled || busy}
        title={disabled ? t('transfer.m093') : t('transfer.exportDescription', { format })}
        onClick={async () => {
          if (controller.current) return;
          const request = new AbortController();
          controller.current = request;
          setBusy(true);
          try {
            const response = await fetch(
              '/api/' +
                kind +
                '/' +
                encodeURIComponent(id) +
                '/risu-export?expectedRevision=' +
                revision,
              { signal: request.signal }
            );
            if (!response.ok) {
              if (response.status === 401) window.dispatchEvent(new Event(sessionRequiredEvent));
              const payload = (await response.json().catch(() => null)) as {
                error?: string;
              } | null;
              throw new Error(
                exportMessages()[payload?.error ?? ''] ?? retainedMessage('transfer.m096')
              );
            }
            const blob = await response.blob();
            request.signal.throwIfAborted();
            const header = response.headers.get('Content-Disposition') ?? '';
            const name = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = name ? decodeURIComponent(name) : title + '.' + format.toLowerCase();
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (caught) {
            if (!request.signal.aborted) onError((caught as Error).message);
          } finally {
            if (!request.signal.aborted) setBusy(false);
            controller.current = null;
          }
        }}
      >
        <DownloadIcon size={18} aria-hidden="true" />
        {busy ? t('transfer.m097') : t('transfer.exportFormat', { format })}
      </button>
      {linkedModules && <small className="muted">{t('transfer.m099')}</small>}
    </>
  );
}
