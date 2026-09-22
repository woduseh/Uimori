import { useState } from 'react';
import { api } from './api.js';
import { DownloadIcon } from './ui-icons.js';
import type { NativeTransferFile } from '../core/native-transfer.js';

/** Portable user data includes dependent modules and image metadata, never provider credentials. */
export function ResourceExportButton({
  kind,
  id,
  disabled = false,
}: {
  kind: 'content' | 'prompt-preset';
  id: string;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <span className="resource-export-action">
      <button
        type="button"
        className="ghost"
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const file = await api<NativeTransferFile>('/native-transfers/export', {
              items: [{ kind, id }],
            });
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(file)], { type: 'application/json' })
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = `uimori-${kind}-${id}.json`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (caught) {
            setError((caught as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <DownloadIcon size={16} aria-hidden="true" />
        {busy ? '내보내는 중…' : '자료 백업'}
      </button>
      {error && (
        <small role="alert" className="error">
          {error}
        </small>
      )}
    </span>
  );
}
