import { t, useI18n } from './i18n.js';
import { useState } from 'react';
import { downloadArchive } from './archive-download.js';
import { DownloadIcon } from './ui-icons.js';

/** Portable user data includes dependent modules and image metadata, never provider credentials. */
export function ResourceExportButton({
  kind,
  id,
  disabled = false,
  onError,
}: {
  kind: 'content' | 'prompt-preset';
  id: string;
  disabled?: boolean;
  onError: (message: string) => void;
}) {
  useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <span className="resource-export-action">
      <button
        type="button"
        className="ghost"
        disabled={disabled || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await downloadArchive(
              '/native-transfers/export-archive',
              `uimori-${kind}-${id}.uimori`,
              {
                items: [{ kind, id }],
              }
            );
          } catch (caught) {
            onError((caught as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <DownloadIcon size={16} aria-hidden="true" />
        {busy ? t('transfer.m097') : t('transfer.m100')}
      </button>
    </span>
  );
}
