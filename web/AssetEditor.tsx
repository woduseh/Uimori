import { t, useI18n, message as uiMessage, messageRef } from './i18n.js';
import { TransientNotice } from './TransientNotice.js';
import { AssetMetadataEditor } from './AssetMetadataEditor.js';
import { PACKAGE_IMAGE_MIMES } from '../core/package-images.js';
import { useSettingsSaveHandler, type SettingsSaveRegistration } from './useSettingsSaveHandler.js';
import { useEffect, useRef, useState } from 'react';
import { ImageAddIcon } from './ui-icons.js';
import { SaveButton } from './SaveButton.js';
import './settings-actions.css';
import type { Asset } from '../core/product.js';
import { api } from './api.js';
import { DeleteButton } from './DeleteButton.js';

const emptyFields = {
  title: '',
  description: '',
  actor: '',
  outfit: '',
  location: '',
  allowedUse: 'both' as Asset['allowedUse'],
};
const imageUseLabelKeys: Record<Asset['allowedUse'], string> = {
  both: 'library.profileAndStory',
  profile: 'library.profile',
  inline: 'library.story',
};

export function AssetEditor({
  chatId,
  assets,
  refresh,
  onError,
  onDirtyChange,
  onSaveHandlerChange,
  expanded = false,
}: {
  chatId: string;
  assets: Asset[];
  refresh: () => Promise<void>;
  onError: (error: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveHandlerChange?: SettingsSaveRegistration;
  expanded?: boolean;
}) {
  useI18n();
  const [value, setValue] = useState({ ...emptyFields });
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const hasUnsavedChanges =
    busy ||
    file !== null ||
    value.title.length > 0 ||
    value.description.length > 0 ||
    value.actor.length > 0 ||
    value.outfit.length > 0 ||
    value.location.length > 0 ||
    value.allowedUse !== 'both';
  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useSettingsSaveHandler(onSaveHandlerChange, save);
  async function save() {
    if (uploadLock.current) return false;
    if (!file || !value.title.trim()) {
      onError(uiMessage('library.checkTheImageFileAndName'));
      return false;
    }
    uploadLock.current = true;
    setBusy(true);
    setMessage('');
    onError('');
    try {
      if (
        !PACKAGE_IMAGE_MIMES.includes(file.type as (typeof PACKAGE_IMAGE_MIMES)[number]) ||
        file.size > 64 * 1024 * 1024
      )
        throw new Error(uiMessage('library.chooseAnImageUpTo64Mib'));
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error(uiMessage('library.couldNotReadTheImageFile')));
        reader.readAsDataURL(file);
      });
      await api(`/chats/${chatId}/assets`, { ...value, mime: file.type, base64 });
      setFile(null);
      setValue({ ...emptyFields });
      if (fileInput.current) fileInput.current.value = '';
      setMessage(uiMessage('library.imageRegistered'));
      try {
        await refresh();
      } catch (error) {
        onError(
          uiMessage('library.theImageWasRegisteredButTheList', {
            v0: messageRef((error as Error).message),
          })
        );
      }
      return true;
    } catch (error) {
      onError((error as Error).message);
      return false;
    } finally {
      uploadLock.current = false;
      setBusy(false);
    }
  }
  const visible = expanded || open;
  const pageSize = 48;
  const start = Math.min(
    page * pageSize,
    Math.max(0, Math.ceil(assets.length / pageSize) - 1) * pageSize
  );
  const content = (
    <>
      <div className="asset-grid">
        {visible &&
          assets.slice(start, start + pageSize).map((asset) => (
            <figure key={asset.id}>
              <img src={asset.url} alt={asset.description || asset.title} loading="lazy" />
              <figcaption>
                {!asset.packageOwner && <AssetMetadataEditor asset={asset} onSaved={refresh} />}
                {asset.title}
                <small className="ui-meta-row">
                  {[
                    asset.actor,
                    asset.outfit,
                    asset.location,
                    t(imageUseLabelKeys[asset.allowedUse]),
                  ]
                    .filter(Boolean)
                    .map((value, index) => (
                      <span key={index}>{value}</span>
                    ))}
                </small>
                {!asset.packageOwner && asset.url === `/api/assets/${asset.id}` && (
                  <DeleteButton
                    path={`/chats/${encodeURIComponent(chatId)}/assets/${encodeURIComponent(asset.id)}`}
                    title={asset.title}
                    label={t('library.deleteImage')}
                    description={t('library.removeFromTheUploadedImageListFiles')}
                    disabled={busy}
                    onDeleted={async () => {
                      setMessage(uiMessage('library.imageDeleted', { title: asset.title }));
                      await refresh();
                    }}
                    onError={onError}
                  />
                )}
              </figcaption>
            </figure>
          ))}
      </div>
      {visible && assets.length > pageSize && (
        <nav aria-label={t('library.imageListPages')} className="reader-pages">
          <button
            className="secondary"
            disabled={start === 0}
            onClick={() => setPage(Math.max(0, page - 1))}
          >
            {t('library.previousImages')}
          </button>
          <span>
            {start + 1}–{Math.min(start + pageSize, assets.length)} / {assets.length}
          </span>
          <button
            className="secondary"
            disabled={start + pageSize >= assets.length}
            onClick={() => setPage(page + 1)}
          >
            {t('library.nextImages')}
          </button>
        </nav>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="editor-fields editor-grid" disabled={busy}>
          <label className="full">
            {t('library.pngOrJpegImage')}
            <input
              ref={fileInput}
              aria-label={t('library.pngOrJpegImage')}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
              required
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <label>
            {t('library.imageName')}
            <input
              aria-label={t('library.imageName')}
              required
              maxLength={200}
              value={value.title}
              onChange={(event) => setValue({ ...value, title: event.target.value })}
            />
          </label>
          <label>
            {t('library.imageDescription')}
            <input
              aria-label={t('library.imageDescription')}
              required
              maxLength={2000}
              value={value.description}
              onChange={(event) => setValue({ ...value, description: event.target.value })}
            />
          </label>
          <label>
            {t('library.imageCharacter')}
            <input
              aria-label={t('library.imageCharacter')}
              value={value.actor}
              onChange={(event) => setValue({ ...value, actor: event.target.value })}
            />
          </label>
          <label>
            {t('library.imageOutfit')}
            <input
              aria-label={t('library.imageOutfit')}
              value={value.outfit}
              onChange={(event) => setValue({ ...value, outfit: event.target.value })}
            />
          </label>
          <label>
            {t('library.imageLocation')}
            <input
              aria-label={t('library.imageLocation')}
              value={value.location}
              onChange={(event) => setValue({ ...value, location: event.target.value })}
            />
          </label>
          <label>
            {t('library.imageUse')}
            <select
              aria-label={t('library.imageUse')}
              value={value.allowedUse}
              onChange={(event) =>
                setValue({ ...value, allowedUse: event.target.value as Asset['allowedUse'] })
              }
            >
              <option value="both">{t(imageUseLabelKeys.both)}</option>
              <option value="profile">{t(imageUseLabelKeys.profile)}</option>
              <option value="inline">{t(imageUseLabelKeys.inline)}</option>
            </select>
          </label>
          <div className="form-actions full settings-save-actions">
            <TransientNotice message={message} />
            <SaveButton
              icon={ImageAddIcon}
              label={t('library.registerImage')}
              text={t('library.register')}
              disabled={busy || !file}
              aria-busy={busy}
            />
          </div>
        </fieldset>
      </form>
    </>
  );
  return expanded ? (
    <section className="workspace-tools" aria-label={t('library.imagesForThisStory')}>
      {content}
    </section>
  ) : (
    <details className="workspace-tools" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        {t('library.imagesForThisStory')}
        <small>{t('library.itemCount', { count: assets.length })}</small>
      </summary>
      {content}
    </details>
  );
}
