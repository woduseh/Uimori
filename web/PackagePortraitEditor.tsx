import { t, useI18n } from './i18n.js';
import { UiError, uiMessage, type UiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { RisuContent } from '../core/risu-content.js';
import { PACKAGE_IMAGE_MIMES } from '../core/package-images.js';
import { ActionMenu } from './ActionMenu.js';
import { ContentAvatar } from './ContentAvatar.js';
import { withPortraitImage } from './content-portrait.js';
import { Dialog } from './Dialog.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { maxPackageImages, uploadPackageImage } from './package-image-upload.js';
import { CheckIcon, CloseIcon, EditIcon, ImagesIcon, SearchIcon, UploadIcon } from './ui-icons.js';
import './content-picker.css';

export function PackagePortraitEditor({
  value,
  onChange,
  onDirtyChange,
  disabled = false,
  children,
}: {
  value: RisuContent;
  onChange: (value: RisuContent) => void;
  onDirtyChange?: (dirty: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  useI18n();
  const scope = `${value.id}@${value.revision}`;
  const latest = useRef({ value, onChange, onDirtyChange, scope });
  latest.current = { value, onChange, onDirtyChange, scope };
  const generation = useRef(0),
    upload = useRef<AbortController | null>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [visibleCount, setVisibleCount] = useState(50),
    [error, setError] = useState<UiMessage | null>(null),
    [notice, setNotice] = useState<UiMessage | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a package/revision switch invalidates upload ownership and its local dialog state.
  useLayoutEffect(() => {
    generation.current++;
    setBusy(false);
    setOpen(false);
    setQuery('');
    setVisibleCount(50);
    setError(null);
    setNotice(null);
    return () => {
      generation.current++;
      upload.current?.abort();
      upload.current = null;
      latest.current.onDirtyChange?.(false);
    };
  }, [scope]);

  const update = (next: RisuContent) => {
    latest.current.value = next;
    latest.current.onChange(next);
  };
  function selectImage(imageId: string) {
    if (disabled || busy) return;
    const chosen = withPortraitImage(latest.current.value, imageId);
    if (!chosen) return;
    update(chosen.value);
    setOpen(false);
    setError(null);
    setNotice(chosen.widenedUse ? uiMessage('library.changedTheStoryImageToPortraitAnd') : null);
  }
  async function addFile(file: File) {
    if (disabled || upload.current) return;
    if ((latest.current.value.images?.length ?? 0) >= maxPackageImages) {
      setError(uiMessage('library.aResourceCanContainUpTo2'));
      return;
    }
    const token = ++generation.current,
      originalScope = latest.current.scope,
      controller = new AbortController();
    upload.current = controller;
    setBusy(true);
    setError(null);
    setNotice(null);
    latest.current.onDirtyChange?.(true);
    const current = () =>
      generation.current === token &&
      latest.current.scope === originalScope &&
      !controller.signal.aborted;
    try {
      const image = await uploadPackageImage(file, controller.signal, 'profile');
      if (!current()) return;
      if ((latest.current.value.images?.length ?? 0) >= maxPackageImages)
        throw new UiError(uiMessage('library.aResourceCanContainUpTo2'));
      update({
        ...latest.current.value,
        images: [...(latest.current.value.images ?? []), image],
        portraitImageId: image.id,
      });
      setNotice(uiMessage('library.addedForPortraitUseOnlySaveThe'));
    } catch (cause) {
      if (current()) setError(toUiMessage(cause, 'library.couldNotUpload'));
    } finally {
      if (current()) {
        upload.current = null;
        setBusy(false);
        latest.current.onDirtyChange?.(false);
      }
    }
  }
  const images = value.images ?? [],
    needle = query.trim().toLocaleLowerCase();
  const found = images.filter((image) =>
    `${image.title} ${image.description}`.toLocaleLowerCase().includes(needle)
  );
  return (
    <section className="package-portrait-editor" aria-label={t('library.portraitSettings')}>
      <div className="package-portrait-media">
        <ContentAvatar
          className="package-portrait-avatar"
          content={{
            id: value.id,
            revision: value.revision,
            title: value.title,
            description: '',
            kind: 'module',
            text: '',
            loading: 'pinned',
            relatedIds: [],
            package: value,
          }}
        />
        <ActionMenu
          label={t('library.changePortrait')}
          icon={EditIcon}
          className="package-portrait-menu"
        >
          <div className="action-menu-group">
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => fileInput.current?.click()}
            >
              <UploadIcon size={18} aria-hidden="true" />
              {t('library.uploadImage')}
            </button>
            {images.length > 0 && (
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => {
                  setQuery('');
                  setVisibleCount(50);
                  setOpen(true);
                }}
              >
                <ImagesIcon size={18} aria-hidden="true" />
                {t('library.chooseAnExistingImage')}
              </button>
            )}
            {value.portraitImageId && (
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => {
                  const next = { ...latest.current.value };
                  delete next.portraitImageId;
                  update(next);
                  setError(null);
                  setNotice(uiMessage('library.portraitDesignationRemovedTheImageRemainsIn'));
                }}
              >
                <CloseIcon size={18} aria-hidden="true" />
                {t('library.removePortraitDesignation')}
              </button>
            )}
          </div>
        </ActionMenu>
      </div>
      <div className="package-portrait-identity">{children}</div>
      <input
        ref={fileInput}
        type="file"
        hidden
        accept={PACKAGE_IMAGE_MIMES.join(',')}
        aria-label={t('library.uploadPortrait')}
        disabled={disabled || busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void addFile(file);
        }}
      />
      {(busy || notice || error) && (
        <div className="package-portrait-status">
          {busy && (
            <div className="package-portrait-actions">
              <LoadingState presentation="inline" label={uiMessage('library.uploadingPortrait')} />
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  generation.current++;
                  upload.current?.abort();
                  upload.current = null;
                  setBusy(false);
                  latest.current.onDirtyChange?.(false);
                  setNotice(uiMessage('library.imageUploadCanceled'));
                }}
              >
                {t('library.cancelUpload')}
              </button>
            </div>
          )}
          {notice && <NoticeBanner>{notice}</NoticeBanner>}
          {error && <NoticeBanner tone="error">{error}</NoticeBanner>}
        </div>
      )}
      <Dialog
        open={open}
        title={t('library.choosePortrait')}
        onClose={() => setOpen(false)}
        scopeKey={scope}
      >
        <label>
          <span className="sr-only">{t('library.searchImages')}</span>
          <span className="content-picker-search-field">
            <SearchIcon size={17} aria-hidden="true" />
            <input
              type="search"
              aria-label={t('library.searchPortraits')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(50);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
              placeholder={t('library.nameOrDescription')}
            />
          </span>
        </label>
        <div className="package-portrait-choices">
          {found.slice(0, visibleCount).map((image) => (
            <button
              type="button"
              className="secondary content-picker-choice"
              key={image.id}
              aria-pressed={value.portraitImageId === image.id}
              disabled={disabled || busy}
              onClick={() => selectImage(image.id)}
            >
              <span className="content-avatar" aria-hidden="true">
                <img src={`/api/package-image-blobs/${image.blobHash}`} alt="" loading="lazy" />
              </span>
              <span className="content-picker-copy">
                <strong>{image.title}</strong>
                <small>
                  {image.allowedUse === 'inline'
                    ? t('library.storyOnly')
                    : image.allowedUse === 'profile'
                      ? t('library.portraitOnly')
                      : t('library.portraitAndStory')}
                </small>
              </span>
              {value.portraitImageId === image.id && <CheckIcon size={18} aria-hidden="true" />}
            </button>
          ))}
          {!found.length && <p className="muted">{t('library.noSearchResults')}</p>}
        </div>
        {found.length > visibleCount && (
          <button
            type="button"
            className="secondary"
            onClick={() => setVisibleCount((count) => count + 50)}
          >
            {t('library.moreImages', { visible: visibleCount, total: found.length })}
          </button>
        )}
      </Dialog>
    </section>
  );
}
