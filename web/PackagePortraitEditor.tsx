import { t, useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { useLayoutEffect, useRef, useState } from 'react';
import type { RisuContent } from '../core/risu-content.js';
import { PACKAGE_IMAGE_MIMES } from '../core/package-images.js';
import { ContentAvatar } from './ContentAvatar.js';
import { Dialog } from './Dialog.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { maxPackageImages, uploadPackageImage } from './package-image-upload.js';
import { SearchIcon } from './ui-icons.js';
import './content-picker.css';

/** Edits the current authoring draft; representative image changes are saved by the parent. */
export function PackagePortraitEditor({
  value,
  onChange,
  onDirtyChange,
  disabled = false,
}: {
  value: RisuContent;
  onChange: (value: RisuContent) => void;
  onDirtyChange?: (dirty: boolean) => void;
  disabled?: boolean;
}) {
  useI18n();
  const scope = `${value.id}@${value.revision}`;
  const latest = useRef({ value, onChange, onDirtyChange, scope });
  latest.current = { value, onChange, onDirtyChange, scope };
  const generation = useRef(0),
    upload = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [visibleCount, setVisibleCount] = useState(50),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a package/revision switch invalidates upload ownership and its local dialog state.
  useLayoutEffect(() => {
    generation.current++;
    setBusy(false);
    setOpen(false);
    setQuery('');
    setVisibleCount(50);
    setError('');
    setNotice('');
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
    const current = latest.current.value,
      selected = current.images?.find((image) => image.id === imageId);
    if (!selected) return;
    update({
      ...current,
      portraitImageId: selected.id,
      images: current.images?.map((image) =>
        image.id === selected.id && image.allowedUse === 'inline'
          ? { ...image, allowedUse: 'both' }
          : image
      ),
    });
    setOpen(false);
    setError('');
    setNotice(
      selected.allowedUse === 'inline'
        ? uiMessage('library.changedTheStoryImageToPortraitAnd')
        : uiMessage('library.portraitSelectedSaveTheResourceToApply')
    );
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
    setError('');
    setNotice('');
    latest.current.onDirtyChange?.(true);
    const current = () =>
      generation.current === token &&
      latest.current.scope === originalScope &&
      !controller.signal.aborted;
    try {
      const image = await uploadPackageImage(file, controller.signal, 'profile');
      if (!current()) return;
      if ((latest.current.value.images?.length ?? 0) >= maxPackageImages)
        throw new Error(uiMessage('library.aResourceCanContainUpTo2'));
      update({
        ...latest.current.value,
        images: [...(latest.current.value.images ?? []), image],
        portraitImageId: image.id,
      });
      setNotice(uiMessage('library.addedForPortraitUseOnlySaveThe'));
    } catch (cause) {
      if (current())
        setError(cause instanceof Error ? cause.message : uiMessage('library.couldNotUpload'));
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
  const portrait = images.find((image) => image.id === value.portraitImageId);
  return (
    <section className="package-portrait-editor" aria-label={t('library.portraitSettings')}>
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
      <div className="package-portrait-controls">
        <strong>{t('library.listPortrait')}</strong>
        {portrait && <small>{portrait.title}</small>}
        <div className="package-portrait-actions">
          <label
            className={`secondary package-portrait-upload${disabled || busy ? ' is-disabled' : ''}`}
          >
            {t('library.uploadImage')}
            <input
              type="file"
              accept={PACKAGE_IMAGE_MIMES.join(',')}
              aria-label={t('library.uploadPortrait')}
              disabled={disabled || busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void addFile(file);
              }}
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={disabled || busy || !images.length}
            onClick={() => {
              setQuery('');
              setVisibleCount(50);
              setOpen(true);
            }}
          >
            {t('library.chooseAnExistingImage')}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={disabled || busy || !value.portraitImageId}
            onClick={() => {
              const next = { ...latest.current.value };
              delete next.portraitImageId;
              update(next);
              setError('');
              setNotice(uiMessage('library.portraitDesignationRemovedTheImageRemainsIn'));
            }}
          >
            {t('library.removePortraitDesignation')}
          </button>
        </div>
        <small>{t('library.pngJpegWebpAvifGifUpTo')}</small>
        {busy && (
          <div className="package-portrait-actions">
            <LoadingState presentation="inline" label={t('library.uploadingPortrait')} />
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
        {notice && <NoticeBanner>{translateMessage(notice)}</NoticeBanner>}
        {error && <NoticeBanner tone="error">{translateMessage(error)}</NoticeBanner>}
      </div>
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
                    ? t('library.selectingThisImageAllowsPortraitAndStory')
                    : image.allowedUse === 'profile'
                      ? t('library.portraitOnly')
                      : t('library.portraitAndStory')}
                </small>
              </span>
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
