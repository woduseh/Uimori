import { useRef } from 'react';
import { File as FileIcon, Paperclip, X } from 'lucide-react';
import type { RequestFile } from '../core/request-files.js';
import type { DraftFile, HelperAttachmentDraft } from './helper-attachment-draft.js';
import { DraftRequestImages } from './RequestImages.js';
import { IconButton } from './IconButton.js';
import { formatNumber, useI18n } from './i18n.js';
import './helper-attachments.css';

export function HelperAttachmentPicker({
  disabled,
  addFiles,
  accept,
}: {
  disabled: boolean;
  addFiles: (files: File[]) => Promise<void>;
  accept?: string;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton
        icon={Paperclip}
        label={t('helperAttachments.attach')}
        disabled={disabled}
        onClick={() => input.current?.click()}
      />
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple
        hidden
        disabled={disabled}
        aria-label={t('helperAttachments.attach')}
        onChange={(event) => {
          void addFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
    </>
  );
}

function FileChips({
  files,
  remove,
  disabled,
}: {
  files: (DraftFile | RequestFile)[];
  remove?: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return files.length ? (
    <div className="helper-file-chips">
      {files.map((file) => (
        <div
          className="helper-file-chip"
          key={'id' in file ? file.id : `${file.hash}:${file.name}`}
        >
          <FileIcon size={16} aria-hidden="true" />
          {'hash' in file ? (
            <a
              className="helper-file-name"
              title={file.name}
              href={`/api/request-files/${file.hash}?name=${encodeURIComponent(file.name)}`}
              download={file.name}
            >
              {file.name}
            </a>
          ) : (
            <span className="helper-file-name" title={file.name}>
              {file.name}
            </span>
          )}
          <span className="helper-file-size">
            {t('helperAttachments.fileSize', {
              kb: formatNumber(Math.ceil(('blob' in file ? file.blob.size : file.bytes) / 1024)),
            })}
          </span>
          {remove && 'id' in file && (
            <IconButton
              icon={X}
              label={t('prompts.removeNamed', { name: file.name })}
              disabled={disabled}
              onClick={() => remove(file.id)}
            />
          )}
        </div>
      ))}
    </div>
  ) : null;
}

export function HelperDraftAttachments({
  draft,
  remove,
  disabled,
}: {
  draft: HelperAttachmentDraft;
  remove: (id: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  if (!draft.images.length && !draft.files.length) return null;
  return (
    <div className="helper-draft-attachments" aria-label={t('helperAttachments.attached')}>
      <DraftRequestImages images={draft.images} remove={remove} disabled={disabled} />
      <FileChips files={draft.files} remove={remove} disabled={disabled} />
    </div>
  );
}
export function HelperStoredFiles({ files }: { files?: RequestFile[] }) {
  return files?.length ? <FileChips files={files} /> : null;
}
