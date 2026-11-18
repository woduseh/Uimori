import { t, useI18n, message as uiMessage, messageRef } from './i18n.js';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { Library } from '../core/product.js';
import type {
  LibraryCategory,
  LibraryFolder,
  LibraryItemKey,
  LibraryOrganization,
} from '../core/library-organization.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';
import { DeleteButton } from './DeleteButton.js';
import { ActionMenu } from './ActionMenu.js';
import {
  CheckIcon,
  CloseIcon,
  EditIcon,
  FolderAddIcon,
  FolderIcon,
  ImagesIcon,
  MoreIcon,
  MoveIcon,
} from './ui-icons.js';
import { PACKAGE_IMAGE_MIMES } from '../core/package-images.js';
import { uploadPackageImage } from './package-image-upload.js';
import './library-folders.css';
import './content-picker.css';

const categoryLabelKeys: Record<LibraryCategory, string> = {
  bot: 'library.bot',
  persona: 'library.persona',
  module: 'library.module',
  prompts: 'library.prompts',
};
export type FolderFilter = 'all' | 'unclassified' | string;
const blobUrl = (hash: string) => `/api/package-image-blobs/${hash}`;
const blobHash = (url: string) => /\/api\/package-image-blobs\/([a-f0-9]{64})$/u.exec(url)?.[1];

/** A chosen image fills the cover; otherwise up to four portraits from the folder stand in. */
function FolderCover({ folder, portraits }: { folder: LibraryFolder; portraits?: string[] }) {
  const urls = folder.coverImageHash
    ? [blobUrl(folder.coverImageHash)]
    : (portraits ?? []).slice(0, 4);
  return urls.length ? (
    <span className="library-folder-cover" data-count={urls.length} aria-hidden="true">
      {urls.map((url) => (
        <img key={url} src={url} alt="" loading="lazy" draggable={false} />
      ))}
    </span>
  ) : (
    <FolderIcon size={28} aria-hidden="true" />
  );
}

export function useLibraryOrganization(
  library: Library | null,
  reload: () => Promise<void>,
  onError: (error: string) => void
) {
  useI18n();
  const [organization, setOrganization] = useState<LibraryOrganization | null>(
    library?.organization ?? null
  );
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const loadVersion = useRef(0);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    const request = ++loadVersion.current;
    if (library?.organization) {
      // The parent excludes stale Library responses. Archive restoration may lower this CAS token.
      setOrganization(library.organization);
      return;
    }
    if (!library) setOrganization(null);
    let alive = true;
    if (library)
      void api<LibraryOrganization>('/library/organization')
        .then((value) => {
          if (alive && request === loadVersion.current) setOrganization(value);
        })
        .catch((error: Error) => {
          if (alive && request === loadVersion.current) errorHandler.current(error.message);
        });
    return () => {
      alive = false;
    };
  }, [library]);
  async function mutate(
    path: string,
    body: Record<string, unknown>,
    method = 'POST',
    expectedRevision = organization?.revision
  ) {
    if (lock.current || expectedRevision === undefined) return false;
    lock.current = true;
    const request = ++loadVersion.current;
    setBusy(true);
    try {
      const result = await api<LibraryOrganization>(path, { ...body, expectedRevision }, method);
      if (request === loadVersion.current) setOrganization(result);
      try {
        await reload();
      } catch (error) {
        onError(
          uiMessage('library.changesWereSavedButTheListCould', {
            v0: messageRef((error as Error).message),
          })
        );
      }
      return true;
    } catch (error) {
      onError((error as Error).message);
      try {
        const refresh = ++loadVersion.current;
        const latest = await api<LibraryOrganization>('/library/organization');
        if (refresh === loadVersion.current) setOrganization(latest);
        await reload();
      } catch {
        /* Preserve the original mutation error; a later reload can recover. */
      }
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { organization, busy, mutate };
}
type LibraryOrganizer = ReturnType<typeof useLibraryOrganization>;

export function LibraryItemMenu({
  title,
  children,
  className = '',
  icon = MoreIcon,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  icon?: typeof MoreIcon;
}) {
  useI18n();
  return (
    <ActionMenu label={title} className={`library-item-menu ${className}`} icon={icon}>
      {children}
    </ActionMenu>
  );
}

export function LibraryFolders({
  category,
  organizer,
  value,
  onChange,
  counts,
  covers,
  reload,
  onError,
  presentation = 'breadcrumb',
  view = 'cards',
  draggedItemId = null,
  dropFolderId = null,
  onFolderDragOver,
  onFolderDragLeave,
  onFolderDrop,
}: {
  presentation?: 'cards' | 'breadcrumb';
  /** Card folders follow the list/card choice made for the items below them. */
  view?: 'cards' | 'list';
  category: LibraryCategory;
  organizer: LibraryOrganizer;
  value: FolderFilter;
  onChange: (value: FolderFilter) => void;
  counts: Record<string, number>;
  /** Portrait URLs of resources inside each folder: the automatic cover and the cover choices. */
  covers?: Record<string, string[]>;
  reload: () => Promise<void>;
  onError: (error: string) => void;
  draggedItemId?: string | null;
  dropFolderId?: string | null;
  onFolderDragOver?: (folderId: string, event: DragEvent<HTMLElement>) => void;
  onFolderDragLeave?: (folderId: string, event: DragEvent<HTMLElement>) => void;
  onFolderDrop?: (folderId: string, event: DragEvent<HTMLElement>) => void;
}) {
  useI18n();
  const [edit, setEdit] = useState<{ folder: LibraryFolder | null; revision: number } | null>(null);
  const [title, setTitle] = useState('');
  const [coverFolderId, setCoverFolderId] = useState<string | null>(null);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [coverError, setCoverError] = useState('');
  const coverUpload = useRef<AbortController | null>(null);
  useEffect(() => () => coverUpload.current?.abort(), []);
  const draggedFolder = useRef<string | null>(null);
  const [folderDrop, setFolderDrop] = useState<{ id: string; edge: 'before' | 'after' } | null>(
    null
  );
  const { organization, busy, mutate } = organizer;
  const folders =
    organization?.folders
      .filter((folder) => folder.category === category)
      .sort((a, b) => a.sortPosition - b.sortPosition) ?? [];
  function openEdit(folder: LibraryFolder | null) {
    if (!organization) return;
    setTitle(folder?.title ?? '');
    setEdit({ folder, revision: organization.revision });
  }
  function closeCover() {
    coverUpload.current?.abort();
    setUploadingCover(false);
    setCoverError('');
    setCoverFolderId(null);
  }
  async function applyCover(folderId: string, coverImageHash: string | null) {
    setCoverError('');
    if (
      await mutate(`/library/folders/${encodeURIComponent(folderId)}`, { coverImageHash }, 'PATCH')
    )
      closeCover();
  }
  async function uploadCover(folderId: string, file: File) {
    coverUpload.current?.abort();
    const controller = new AbortController();
    coverUpload.current = controller;
    setCoverError('');
    setUploadingCover(true);
    try {
      const image = await uploadPackageImage(file, controller.signal, 'profile');
      await applyCover(folderId, image.blobHash);
    } catch (error) {
      if (!controller.signal.aborted) setCoverError((error as Error).message);
    } finally {
      if (coverUpload.current === controller) setUploadingCover(false);
    }
  }
  function folderActions(folder: LibraryFolder) {
    return (
      <>
        <div className="action-menu-group">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => openEdit(folder)}
          >
            <EditIcon size={18} aria-hidden="true" />
            {t('library.rename')}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setCoverFolderId(folder.id)}
          >
            <ImagesIcon size={18} aria-hidden="true" />
            {t('library.changeCover')}
          </button>
        </div>
        <div className="action-menu-group">
          <DeleteButton
            path={`/library/folders/${encodeURIComponent(folder.id)}`}
            revision={organization?.revision}
            title={folder.title}
            label={t('library.deleteFolder')}
            description={t('library.resourcesInThisFolderWillMoveTo')}
            disabled={busy}
            onError={(message) => {
              onError(message);
              void reload();
            }}
            onDeleted={reload}
          />
        </div>
      </>
    );
  }
  const selectedFolder = folders.find((item) => item.id === value);
  const coverFolder = folders.find((item) => item.id === coverFolderId);
  const coverPortraits = (coverFolder && covers?.[coverFolder.id]) || [];
  const coverChoices = coverPortraits.map(blobHash).filter((hash) => hash !== undefined);
  if (coverFolder?.coverImageHash && !coverChoices.includes(coverFolder.coverImageHash))
    coverChoices.unshift(coverFolder.coverImageHash);
  function clearFolderDrag() {
    draggedFolder.current = null;
    setFolderDrop(null);
  }
  function edgeOf(event: DragEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return (
      view === 'list'
        ? event.clientY < bounds.top + bounds.height / 2
        : event.clientX < bounds.left + bounds.width / 2
    )
      ? ('before' as const)
      : ('after' as const);
  }
  function dropFolder(folderId: string, event: DragEvent<HTMLElement>) {
    const id = draggedFolder.current;
    if (!id) {
      onFolderDrop?.(folderId, event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const remaining = folders.filter((folder) => folder.id !== id);
    const index = remaining.findIndex((folder) => folder.id === folderId);
    const beforeFolderId =
      edgeOf(event) === 'before' ? folderId : (remaining[index + 1]?.id ?? null);
    clearFolderDrag();
    if (id === folderId || busy) return;
    void mutate(`/library/folders/${encodeURIComponent(id)}`, { beforeFolderId }, 'PATCH');
  }
  return (
    <aside
      className={presentation === 'cards' ? 'library-folder-grid' : 'library-folders'}
      data-view={presentation === 'cards' ? view : undefined}
      aria-label={t('library.folders2', { v0: t(categoryLabelKeys[category]) })}
    >
      {presentation === 'cards' ? (
        folders.map((folder) => (
          <article
            className="library-folder-card"
            key={folder.id}
            data-folder-id={folder.id}
            data-drop-target={dropFolderId === folder.id ? 'true' : undefined}
            data-drop-position={folderDrop?.id === folder.id ? folderDrop.edge : undefined}
            draggable={!busy}
            onDragStart={(event) => {
              if ((event.target as HTMLElement).closest('.action-menu')) {
                event.preventDefault();
                return;
              }
              draggedFolder.current = folder.id;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', folder.title);
            }}
            onDragEnd={clearFolderDrag}
            onDragOver={(event) => {
              if (!draggedFolder.current) {
                onFolderDragOver?.(folder.id, event);
                return;
              }
              if (draggedFolder.current === folder.id || busy) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'move';
              setFolderDrop({ id: folder.id, edge: edgeOf(event) });
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setFolderDrop(null);
              onFolderDragLeave?.(folder.id, event);
            }}
            onDrop={(event) => dropFolder(folder.id, event)}
          >
            <button
              type="button"
              className="secondary library-folder-open"
              aria-label={t('library.openFolder', { v0: folder.title })}
              onClick={() => onChange(folder.id)}
            >
              <FolderCover folder={folder} portraits={covers?.[folder.id]} />
              <span>
                <strong title={folder.title}>{folder.title}</strong>
                <small>{t('library.itemCount', { count: counts[folder.id] ?? 0 })}</small>
                {draggedItemId && dropFolderId === folder.id && (
                  <small>{t('library.moveHere')}</small>
                )}
              </span>
            </button>
            <LibraryItemMenu title={t('library.folderMenu', { v0: folder.title })}>
              {folderActions(folder)}
            </LibraryItemMenu>
          </article>
        ))
      ) : (
        <>
          <nav className="library-breadcrumb" aria-label={t('library.currentFolder')}>
            <button type="button" className="secondary" onClick={() => onChange('all')}>
              {t('library.all')}
            </button>
            {value !== 'all' && (
              <>
                <span aria-hidden="true">/</span>
                <span aria-current="page">
                  {selectedFolder?.title ?? t('library.uncategorized')}
                </span>
              </>
            )}
          </nav>
          <LibraryItemMenu title={t('library.manageFolders')}>
            <button
              type="button"
              className="secondary"
              disabled={busy || !organization}
              onClick={() => openEdit(null)}
            >
              <FolderAddIcon size={18} aria-hidden="true" />
              {t('library.newFolder')}
            </button>
            {selectedFolder && folderActions(selectedFolder)}
          </LibraryItemMenu>
        </>
      )}
      <Dialog
        open={!!coverFolder}
        title={t('library.folderCover')}
        onClose={() => {
          if (!busy) closeCover();
        }}
      >
        {coverFolder && (
          <div className="library-cover-picker">
            <div className="library-cover-choices">
              <button
                type="button"
                className="secondary library-cover-choice"
                aria-pressed={!coverFolder.coverImageHash}
                disabled={busy || uploadingCover}
                onClick={() => void applyCover(coverFolder.id, null)}
              >
                <FolderCover
                  folder={{ ...coverFolder, coverImageHash: null }}
                  portraits={coverPortraits}
                />
                <span>{t('library.automaticCover')}</span>
                {!coverFolder.coverImageHash && <CheckIcon size={16} aria-hidden="true" />}
              </button>
              {coverChoices.map((hash, index) => (
                <button
                  type="button"
                  className="secondary library-cover-choice"
                  key={hash}
                  aria-label={t('library.coverImageChoice', { index: index + 1 })}
                  aria-pressed={coverFolder.coverImageHash === hash}
                  disabled={busy || uploadingCover}
                  onClick={() => void applyCover(coverFolder.id, hash)}
                >
                  <span className="library-folder-cover" data-count={1} aria-hidden="true">
                    <img src={blobUrl(hash)} alt="" loading="lazy" />
                  </span>
                  {coverFolder.coverImageHash === hash && (
                    <CheckIcon size={16} aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>
            <div className="package-portrait-actions">
              <label
                className={`secondary package-portrait-upload${busy || uploadingCover ? ' is-disabled' : ''}`}
              >
                {t('library.uploadImage')}
                <input
                  type="file"
                  accept={PACKAGE_IMAGE_MIMES.join(',')}
                  aria-label={t('library.uploadCover')}
                  disabled={busy || uploadingCover}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void uploadCover(coverFolder.id, file);
                  }}
                />
              </label>
              {uploadingCover && <span role="status">{t('library.uploadingCover')}</span>}
            </div>
            {coverError && (
              <p className="error" role="alert">
                {coverError}
              </p>
            )}
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!edit}
        title={edit?.folder ? t('library.renameFolder') : t('library.newFolder')}
        onClose={() => {
          if (!busy) setEdit(null);
        }}
      >
        <form
          className="library-folder-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!edit) return;
            const success = await mutate(
              edit.folder
                ? `/library/folders/${encodeURIComponent(edit.folder.id)}`
                : '/library/folders',
              { title: title.trim(), ...(edit.folder ? {} : { category }) },
              edit.folder ? 'PATCH' : 'POST',
              edit.revision
            );
            if (success) setEdit(null);
          }}
        >
          <label>
            {t('library.folderName')}
            <input
              aria-label={t('library.folderName')}
              value={title}
              required
              maxLength={160}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {edit && organization && edit.revision !== organization.revision && (
            <div className="library-folder-review" role="status">
              <p>{t('library.anotherChangeWasAppliedReviewTheLatest')}</p>
              {edit.folder && (
                <p>
                  {t('library.currentFolderName', {
                    name:
                      organization.folders.find((item) => item.id === edit.folder?.id)?.title ??
                      t('library.deletedFolder'),
                  })}
                </p>
              )}
              <button
                type="button"
                className="secondary"
                disabled={
                  busy ||
                  (!!edit.folder &&
                    !organization.folders.some((item) => item.id === edit.folder?.id))
                }
                onClick={() => setEdit({ ...edit, revision: organization.revision })}
              >
                {t('library.reviewLatestState')}
              </button>
            </div>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setEdit(null)}
            >
              <CloseIcon size={18} aria-hidden="true" />
              {t('library.cancel')}
            </button>
            <button
              className="primary"
              disabled={busy || !title.trim() || edit?.revision !== organization?.revision}
            >
              <CheckIcon size={18} aria-hidden="true" />
              {edit?.folder ? t('library.saveName') : t('library.createFolder')}
            </button>
          </div>
        </form>
      </Dialog>
    </aside>
  );
}

export function LibraryMoveDialog({
  items,
  category,
  organizer,
  onClose,
  onMoved,
}: {
  items: LibraryItemKey[] | null;
  category: LibraryCategory;
  organizer: LibraryOrganizer;
  onClose: () => void;
  onMoved: () => void;
}) {
  useI18n();
  const [destination, setDestination] = useState(category);
  const [folderId, setFolderId] = useState('');
  const [revision, setRevision] = useState<number>();
  const { organization, busy, mutate } = organizer;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Capture the revision when the user starts reviewing this move; later changes require explicit review.
  useEffect(() => {
    if (items) {
      setDestination(category);
      setFolderId('');
      setRevision(organization?.revision);
    }
  }, [items, category]);
  const folders = organization?.folders.filter((folder) => folder.category === destination) ?? [];
  const stale = !!folderId && !folders.some((folder) => folder.id === folderId);
  return (
    <Dialog
      open={!!items}
      title={t('library.moveResources')}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="library-folder-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!items || stale) return;
          if (
            await mutate(
              '/library/organization/move',
              { items, category: destination, folderId: folderId || null },
              'POST',
              revision
            )
          )
            onMoved();
        }}
      >
        <p>{t('library.moveCount', { count: items?.length ?? 0 })}</p>
        <label>
          {t('library.category')}
          <select
            aria-label={t('library.destinationCategory')}
            value={destination}
            disabled={busy || category === 'prompts'}
            onChange={(event) => {
              setDestination(event.target.value as LibraryCategory);
              setFolderId('');
            }}
          >
            {(category === 'prompts'
              ? (['prompts'] as const)
              : (['bot', 'persona', 'module'] as const)
            ).map((item) => (
              <option value={item} key={item}>
                {t(categoryLabelKeys[item])}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('library.folders')}
          <select
            aria-label={t('library.destinationFolder')}
            value={folderId}
            disabled={busy}
            onChange={(event) => setFolderId(event.target.value)}
          >
            <option value="">{t('library.uncategorized')}</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.title}
              </option>
            ))}
            {stale && <option value={folderId}>{t('library.deletedFolder')}</option>}
          </select>
        </label>
        {stale && <p role="alert">{t('library.theDestinationFolderWasDeletedChooseAnother')}</p>}
        {organization && revision !== organization.revision && (
          <div className="library-folder-review" role="status">
            <p>{t('library.theLibraryChangedReviewTheCurrentCategory')}</p>
            <button
              type="button"
              className="secondary"
              disabled={busy || stale}
              onClick={() => setRevision(organization.revision)}
            >
              {t('library.reviewLatestState')}
            </button>
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            <CloseIcon size={18} aria-hidden="true" />
            {t('library.cancel')}{' '}
          </button>
          <button
            disabled={
              busy || stale || revision === undefined || revision !== organization?.revision
            }
          >
            <MoveIcon size={18} aria-hidden="true" />
            {t('library.move')}{' '}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
