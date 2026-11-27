import { useI18n, translateMessage, message as uiMessage } from './i18n.js';
import { ImageMetadataFields } from './ImageMetadataFields.js';
import { useLayoutEffect, useRef, useState } from 'react';
import { ActionMenu } from './ActionMenu.js';
import { withPortraitImage } from './content-portrait.js';
import type { RisuContent } from '../core/risu-content.js';
import { PACKAGE_IMAGE_MIMES } from '../core/package-images.js';
import {
  addNativeRisuImage,
  nativeImageNames,
  removeNativeRisuImage,
  replaceNativeRisuImage,
  unmappedNativeAssetCount,
} from '../core/risu-native-assets.js';
import { uploadPackageImage } from './package-image-upload.js';
import { errorDescriptor } from './api-errors.js';
import { Dialog } from './Dialog.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { IconButton } from './IconButton.js';
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  DeleteIcon,
  ImageAddIcon,
  ImagesIcon,
  PersonaIcon,
  SearchIcon,
} from './ui-icons.js';
import './content-picker.css';
import './native-risu-assets.css';
import './deletion.css';

type Props = {
  value: RisuContent;
  onChange: (value: RisuContent) => void;
  onBusyChange?: (busy: boolean) => void;
};
const pageSize = 30;
const NARROW_WIDTH = 600;

export function NativeRisuAssetsEditor({ value, onChange, onBusyChange }: Props) {
  const { t } = useI18n();

  const scope = `${value.id}@${value.revision}`;
  const [narrow, setNarrow] = useState(false);
  const latest = useRef({ value, onChange, onBusyChange, scope, narrow });
  latest.current = { value, onChange, onBusyChange, scope, narrow };
  const upload = useRef<AbortController | null>(null),
    generation = useRef(0);
  const [query, setQuery] = useState(''),
    [selected, setSelected] = useState(''),
    [page, setPage] = useState(0);
  const [uploadFailures, setUploadFailures] = useState<{ file: string; message: string }[]>([]);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<{ key: string; count?: number } | null>(null),
    [error, setError] = useState(''),
    [removing, setRemoving] = useState(''),
    [dropActive, setDropActive] = useState(false),
    [area, setArea] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!area) return;
    const observer = new ResizeObserver(([entry]) =>
      setNarrow(entry!.contentRect.width < NARROW_WIDTH)
    );
    observer.observe(area);
    return () => observer.disconnect();
  }, [area]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision changes invalidate the ownership of uploads and local selection.
  useLayoutEffect(() => {
    generation.current++;
    setBusy(false);
    setSelected('');
    setQuery('');
    setPage(0);
    setNotice(null);
    setError('');
    setUploadFailures([]);
    setRemoving('');
    return () => {
      generation.current++;
      upload.current?.abort();
      upload.current = null;
      latest.current.onBusyChange?.(false);
    };
  }, [scope]);
  const change = (next: RisuContent) => {
    latest.current.value = next;
    latest.current.onChange(next);
  };
  async function filesChosen(files: File[], replacing?: string) {
    if (!files.length || upload.current) return;
    if (!replacing && (latest.current.value.images?.length ?? 0) + files.length > 2000) {
      setError(uiMessage('native.text_1ec208bab4'));
      return;
    }
    const token = ++generation.current,
      owner = latest.current.scope,
      controller = new AbortController();
    upload.current = controller;
    setBusy(true);
    setError('');
    setUploadFailures([]);
    setNotice(null);
    latest.current.onBusyChange?.(true);
    const current = () =>
      generation.current === token && latest.current.scope === owner && !controller.signal.aborted;
    let completed = 0;
    const failures: { file: string; message: string }[] = [];
    try {
      for (const file of files) {
        if (!current()) return;
        try {
          const image = await uploadPackageImage(file, controller.signal, 'both');
          if (!current()) return;
          const next = replacing
            ? replaceNativeRisuImage(latest.current.value, replacing, image)
            : addNativeRisuImage(latest.current.value, image);
          change(next);
          if (replacing || !latest.current.narrow) setSelected(replacing ?? image.id);
          completed++;
        } catch (cause) {
          if (!current()) return;
          failures.push({
            file: file.name,
            message:
              cause instanceof Error ? errorDescriptor(cause) : uiMessage('native.text_6d75f11c59'),
          });
        }
      }
      if (current()) {
        setNotice(
          replacing && completed
            ? { key: 'native.text_0efca75d2d' }
            : { key: 'native.imagesAdded', count: completed }
        );
        setUploadFailures(failures.slice(0, 5));
      }
    } finally {
      if (current()) {
        upload.current = null;
        setBusy(false);
        latest.current.onBusyChange?.(false);
      }
    }
  }
  function setPortrait(imageId: string) {
    if (busy) return;
    const chosen = withPortraitImage(latest.current.value, imageId);
    if (!chosen) return;
    change(chosen.value);
    setError('');
    setNotice({
      key: chosen.widenedUse ? 'library.changedTheStoryImageToPortraitAnd' : 'native.portraitSet',
    });
  }
  async function copyReference(imageId: string) {
    const current = latest.current.value;
    const name =
      nativeImageNames(current, imageId)[0] ??
      current.images?.find((image) => image.id === imageId)?.title ??
      '';
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(name);
      setError('');
      setNotice({ key: 'native.referenceNameCopied' });
    } catch {
      setNotice(null);
      setError(uiMessage('helpers.m130'));
    }
  }
  const images = value.images ?? [],
    needle = query.trim().toLocaleLowerCase();
  const found = images.filter((image) =>
    `${image.title} ${image.description} ${nativeImageNames(value, image.id).join(' ')}`
      .toLocaleLowerCase()
      .includes(needle)
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(found.length / pageSize) - 1));
  const active = images.find((image) => image.id === selected),
    pending = images.find((image) => image.id === removing);
  const missing = unmappedNativeAssetCount(value);
  const detail = (active: NonNullable<RisuContent['images']>[number]) => {
    const names = nativeImageNames(value, active.id);
    return (
      <>
        <img
          className="native-assets-preview"
          src={`/api/package-image-blobs/${active.blobHash}`}
          alt={active.title}
        />
        <ImageMetadataFields
          image={active}
          portrait={active.id === value.portraitImageId}
          onChange={(next) =>
            change({
              ...value,
              images: images.map((image) => (image.id === next.id ? next : image)),
            })
          }
        />
        <details>
          <summary>{t('native.text_24016d85c7')}</summary>
          <code>{names.join(', ') || active.id}</code>
        </details>
        <div className="native-assets-actions">
          <label className={`secondary file-picker-button${busy ? ' is-disabled' : ''}`}>
            {t('native.text_597b8746b1')}
            <input
              type="file"
              accept={PACKAGE_IMAGE_MIMES.join(',')}
              disabled={busy}
              aria-label={t('native.text_bf32707568')}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void filesChosen([file], active.id);
              }}
            />
          </label>
          <IconButton
            label={t('native.text_8a2c3b9aec')}
            icon={DeleteIcon}
            disabled={busy}
            onClick={() => setRemoving(active.id)}
          />
          {!narrow && (
            <IconButton
              label={t('shared.close', { title: active.title })}
              icon={CloseIcon}
              className="secondary"
              onClick={() => setSelected('')}
            />
          )}
        </div>
      </>
    );
  };
  return (
    <section
      ref={setArea}
      className="native-risu-assets"
      aria-label={t('native.text_6b1779397e')}
      data-drop-active={dropActive || undefined}
      onDragOver={(event) => {
        if (busy || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDropActive(false);
        if (!busy) void filesChosen(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="native-assets-toolbar">
        <label className="native-assets-search">
          <span className="sr-only">{t('native.text_a887a65c92')}</span>
          <span className="content-picker-search-field">
            <SearchIcon size={17} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder={t('native.text_4671f4390f')}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
            />
          </span>
        </label>
        <label className={`secondary file-picker-button${busy ? ' is-disabled' : ''}`}>
          <ImageAddIcon size={18} aria-hidden="true" />
          {t('native.text_d4d4ce5c0e')}
          <input
            type="file"
            multiple
            accept={PACKAGE_IMAGE_MIMES.join(',')}
            disabled={busy}
            aria-label={t('native.text_600611f249')}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              void filesChosen(files);
            }}
          />
        </label>
      </div>
      {missing > 0 && (
        <p className="muted native-assets-unavailable">
          {t('native.imagesMissing', { count: missing })}
        </p>
      )}
      {busy && <LoadingState presentation="inline" label={t('native.text_d504143bb7')} />}
      {notice && (
        <NoticeBanner>
          {t(notice.key, notice.count === undefined ? {} : { count: notice.count })}
        </NoticeBanner>
      )}
      {(error || uploadFailures.length > 0) && (
        <NoticeBanner tone="error" className="native-assets-error">
          {error && translateMessage(error)}
          {uploadFailures.map((failure, index) => (
            <p key={index}>
              {t('native.fileError', {
                file: failure.file,
                error: translateMessage(failure.message),
              })}
            </p>
          ))}
        </NoticeBanner>
      )}
      <div className="native-assets-layout" data-narrow={narrow || undefined}>
        <div>
          <div className="native-assets-grid" aria-label={t('native.text_3a05fee3d8')}>
            {found.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((image) => (
              <div
                key={image.id}
                className={`native-assets-tile${image.id === selected ? ' is-selected' : ''}`}
              >
                <button
                  type="button"
                  className="secondary native-assets-tile-select"
                  aria-pressed={image.id === selected}
                  onClick={() => setSelected(image.id === selected ? '' : image.id)}
                >
                  <img
                    src={`/api/package-image-blobs/${image.blobHash}`}
                    alt=""
                    loading="lazy"
                    draggable={false}
                  />
                  <span>{image.title}</span>
                  {image.id === selected && (
                    <CheckIcon className="native-assets-selected" size={16} aria-hidden="true" />
                  )}
                  {image.id === value.portraitImageId && (
                    <small>{t('native.text_384374b51a')}</small>
                  )}
                </button>
                <ActionMenu
                  label={t('native.assetActions', { name: image.title })}
                  className="native-assets-tile-menu"
                >
                  <div className="action-menu-group">
                    <button
                      type="button"
                      disabled={busy || image.id === value.portraitImageId}
                      onClick={() => setPortrait(image.id)}
                    >
                      <PersonaIcon size={18} aria-hidden="true" />
                      {t('native.setAsPortrait')}
                    </button>
                    <button type="button" onClick={() => void copyReference(image.id)}>
                      <CopyIcon size={18} aria-hidden="true" />
                      {t('native.copyReferenceName')}
                    </button>
                  </div>
                  <div className="action-menu-group">
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => setRemoving(image.id)}
                    >
                      <DeleteIcon size={18} aria-hidden="true" />
                      {t('native.removeAsset')}
                    </button>
                  </div>
                </ActionMenu>
              </div>
            ))}
          </div>
          {!found.length && (
            <div className="native-assets-empty">
              <ImagesIcon size={28} aria-hidden="true" />
              <p>{images.length ? t('native.text_a9a4407910') : t('native.text_06183c3690')}</p>
              {!images.length && <p>{t('native.assetsDropHint')}</p>}
              {query && (
                <button type="button" className="ghost" onClick={() => setQuery('')}>
                  {t('library.clearSearch')}
                </button>
              )}
            </div>
          )}
          {found.length > pageSize && (
            <div className="native-assets-pages">
              <button
                type="button"
                className="secondary"
                disabled={!currentPage}
                onClick={() => setPage(currentPage - 1)}
              >
                {t('native.text_dc03452ea5')}
              </button>
              <span>
                {currentPage + 1} / {Math.ceil(found.length / pageSize)}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={(currentPage + 1) * pageSize >= found.length}
                onClick={() => setPage(currentPage + 1)}
              >
                {t('native.text_854c76f3bc')}
              </button>
            </div>
          )}
        </div>
        {!narrow && (
          <aside className="native-assets-detail" aria-label={t('native.text_9c9dbdd18c')}>
            {active ? (
              detail(active)
            ) : (
              <p className="native-assets-detail-empty">{t('native.assetInspectorEmpty')}</p>
            )}
          </aside>
        )}
      </div>
      <Dialog
        open={narrow && !!active}
        title={active?.title ?? t('native.text_9c9dbdd18c')}
        onClose={() => setSelected('')}
        scopeKey={scope}
        className="native-assets-detail-dialog"
      >
        {active && <div className="native-assets-detail">{detail(active)}</div>}
      </Dialog>
      <Dialog
        open={!!pending}
        title={t('native.text_7900d467e4')}
        variant="confirmation"
        className="delete-dialog"
        onClose={() => setRemoving('')}
        scopeKey={scope}
        role="alertdialog"
      >
        <p>
          {t('native.removeImageDescription', {
            name: pending ? nativeImageNames(value, pending.id).join(', ') || pending.title : '',
          })}
        </p>
        <p className="muted">{t('native.text_07afd47e83')}</p>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={() => setRemoving('')}>
            {t('native.text_19b2d19bc1')}
          </button>
          <button
            type="button"
            className="delete-button"
            onClick={() => {
              if (!pending || busy) return;
              try {
                change(removeNativeRisuImage(latest.current.value, pending.id));
                setSelected('');
                setRemoving('');
                setNotice({ key: 'native.text_00ea313249' });
                setError('');
                setUploadFailures([]);
              } catch (cause) {
                setRemoving('');
                setError(
                  cause instanceof Error
                    ? errorDescriptor(cause)
                    : uiMessage('native.text_949e1ae936')
                );
              }
            }}
          >
            {t('native.text_3f51da3e6a')}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
