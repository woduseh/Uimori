import { useState } from 'react';
import { downloadArchive } from './archive-download.js';
import { DownloadIcon } from './ui-icons.js';

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
            await downloadArchive(
              '/native-transfers/export-archive',
              `uimori-${kind}-${id}.uimori`,
              {
                items: [{ kind, id }],
              }
            );
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
