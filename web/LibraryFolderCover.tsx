import { useEffect, useRef, useState } from 'react';
import type { LibraryFolder } from '../core/library-organization.js';
import { PACKAGE_IMAGE_MIMES } from '../core/package-images.js';
import { Dialog } from './Dialog.js';
import { t, useI18n } from './i18n.js';
import { uploadPackageImage } from './package-image-upload.js';
import { CheckIcon, FolderIcon } from './ui-icons.js';
import './library-folder-cover.css';
import './content-picker.css';

const folderCoverUrl = (hash: string) => `/api/package-image-blobs/${hash}`;
const blobHash = (url: string) => /\/api\/package-image-blobs\/([a-f0-9]{64})$/u.exec(url)?.[1];

/** A chosen image fills the cover; otherwise up to four portraits from the folder stand in. */
export function LibraryFolderCover({
  coverImageHash,
  portraits = [],
  iconSize,
}: {
  coverImageHash: string | null;
  portraits?: string[];
  iconSize: number;
}) {
  const urls = coverImageHash ? [folderCoverUrl(coverImageHash)] : portraits.slice(0, 4);
  return urls.length ? (
    <span className="library-folder-cover" data-count={urls.length} aria-hidden="true">
      {urls.map((url) => (
        <img key={url} src={url} alt="" loading="lazy" draggable={false} />
      ))}
    </span>
  ) : (
    <FolderIcon size={iconSize} aria-hidden="true" />
  );
}

/** Each choice applies at once; the owner saves it and reports whether the save succeeded. */
export function LibraryFolderCoverDialog({
  folder,
  portraits = [],
  busy,
  onApply,
  onClose,
}: {
  folder: LibraryFolder | null | undefined;
  portraits?: string[];
  busy: boolean;
  onApply: (coverImageHash: string | null) => Promise<boolean>;
  onClose: () => void;
}) {
  useI18n();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const upload = useRef<AbortController | null>(null);
  useEffect(() => () => upload.current?.abort(), []);
  function close() {
    upload.current?.abort();
    setUploading(false);
    setError('');
    onClose();
  }
  async function apply(coverImageHash: string | null) {
    setError('');
    if (await onApply(coverImageHash)) close();
  }
  async function uploadCover(file: File) {
    upload.current?.abort();
    const controller = new AbortController();
    upload.current = controller;
    setError('');
    setUploading(true);
    try {
      const image = await uploadPackageImage(file, controller.signal, 'profile');
      await apply(image.blobHash);
    } catch (reason) {
      if (!controller.signal.aborted) setError((reason as Error).message);
    } finally {
      if (upload.current === controller) setUploading(false);
    }
  }
  const choices = portraits.map(blobHash).filter((hash) => hash !== undefined);
  if (folder?.coverImageHash && !choices.includes(folder.coverImageHash))
    choices.unshift(folder.coverImageHash);
  const disabled = busy || uploading;
  return (
    <Dialog
      open={!!folder}
      title={t('library.folderCover')}
      onClose={() => {
        if (!busy) close();
      }}
    >
      {folder && (
        <div className="library-cover-picker">
          <div className="library-cover-choices">
            <button
              type="button"
              className="secondary library-cover-choice"
              aria-pressed={!folder.coverImageHash}
              disabled={disabled}
              onClick={() => void apply(null)}
            >
              <LibraryFolderCover coverImageHash={null} portraits={portraits} iconSize={28} />
              <span>{t('library.automaticCover')}</span>
              {!folder.coverImageHash && <CheckIcon size={16} aria-hidden="true" />}
            </button>
            {choices.map((hash, index) => (
              <button
                type="button"
                className="secondary library-cover-choice"
                key={hash}
                aria-label={t('library.coverImageChoice', { index: index + 1 })}
                aria-pressed={folder.coverImageHash === hash}
                disabled={disabled}
                onClick={() => void apply(hash)}
              >
                <span className="library-folder-cover" data-count={1} aria-hidden="true">
                  <img src={folderCoverUrl(hash)} alt="" loading="lazy" />
                </span>
                {folder.coverImageHash === hash && <CheckIcon size={16} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <div className="package-portrait-actions">
            <label className={`secondary package-portrait-upload${disabled ? ' is-disabled' : ''}`}>
              {t('library.uploadImage')}
              <input
                type="file"
                accept={PACKAGE_IMAGE_MIMES.join(',')}
                aria-label={t('library.uploadCover')}
                disabled={disabled}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file) void uploadCover(file);
                }}
              />
            </label>
            {uploading && <span role="status">{t('library.uploadingCover')}</span>}
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
