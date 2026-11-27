import { t, useI18n, message as uiMessage, messageRef } from './i18n.js';
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { Library } from '../core/product.js';
import type {
  LibraryCategory,
  LibraryFolder,
  LibraryItemKey,
  LibraryOrganization,
} from '../core/library-organization.js';
import { type EndpointInput, libraryEndpoints } from '#contracts';
import { callEndpoint } from './api.js';
import { Dialog } from './Dialog.js';
import { DeleteButton } from './DeleteButton.js';
import { ActionMenu } from './ActionMenu.js';
import { IconButton } from './IconButton.js';
import { ScrollStrip } from './ScrollStrip.js';
import {
  CheckIcon,
  CloseIcon,
  EditIcon,
  ExpandIcon,
  FolderAddIcon,
  ImagesIcon,
  MoreIcon,
  MoveIcon,
} from './ui-icons.js';
import { LibraryFolderCover, LibraryFolderCoverDialog } from './LibraryFolderCover.js';
import { readCollapsedFolders, saveCollapsedFolders } from './library-list-preferences.js';
import './library-folders.css';

const categoryLabelKeys: Record<LibraryCategory, string> = {
  bot: 'library.bot',
  persona: 'library.persona',
  module: 'library.module',
  prompts: 'library.prompts',
};
export type FolderFilter = 'all' | string;
export type LibraryWrite = (typeof libraryEndpoints)[Exclude<
  keyof typeof libraryEndpoints,
  'readOrganization'
>];
type WithoutRevision<T> = T extends unknown ? Omit<T, 'expectedRevision'> : never;
export type LibraryWriteInput<E extends LibraryWrite> = WithoutRevision<EndpointInput<E>>;
const sendLibraryWrite = callEndpoint as (
  endpoint: LibraryWrite,
  input: Record<string, unknown>
) => Promise<LibraryOrganization>;

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
      setOrganization(library.organization);
      return;
    }
    if (!library) setOrganization(null);
    let alive = true;
    if (library)
      void callEndpoint(libraryEndpoints.readOrganization)
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
  async function mutate<E extends LibraryWrite>(
    endpoint: E,
    input: LibraryWriteInput<E>,
    expectedRevision = organization?.revision
  ) {
    if (lock.current || expectedRevision === undefined) return false;
    lock.current = true;
    const request = ++loadVersion.current;
    setBusy(true);
    try {
      const result = await sendLibraryWrite(endpoint, { ...input, expectedRevision });
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
        const latest = await callEndpoint(libraryEndpoints.readOrganization);
        if (refresh === loadVersion.current) setOrganization(latest);
        await reload();
      } catch {}
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { organization, busy, mutate };
}
type LibraryOrganizer = ReturnType<typeof useLibraryOrganization>;

function moveInput(
  ids: string[],
  category: LibraryCategory,
  folderId: string | null
): LibraryWriteInput<typeof libraryEndpoints.moveItems> {
  return category === 'prompts'
    ? { category, folderId, items: ids.map((id) => ({ kind: 'prompt-preset', id })) }
    : { category, folderId, items: ids.map((id) => ({ kind: 'content', id })) };
}

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

export function sortedFolders(
  organization: LibraryOrganization | null | undefined,
  category: LibraryCategory
) {
  return (
    organization?.folders
      .filter((folder) => folder.category === category)
      .sort((a, b) => a.sortPosition - b.sortPosition) ?? []
  );
}

export function useCollapsedFolders(organization: LibraryOrganization | null) {
  const [collapsed, setCollapsed] = useState(readCollapsedFolders);
  function toggle(id: string) {
    const known = new Set(organization?.folders.map((folder) => folder.id));
    const next = (
      collapsed.includes(id) ? collapsed.filter((value) => value !== id) : [...collapsed, id]
    ).filter((value) => !organization || known.has(value));
    setCollapsed(next);
    saveCollapsedFolders(next);
  }
  return { collapsed, toggle };
}

export function useLibraryFolderEditor({
  category,
  organizer,
  reload,
  onError,
  covers,
}: {
  category: LibraryCategory;
  organizer: LibraryOrganizer;
  reload: () => Promise<void>;
  onError: (error: string) => void;
  covers?: Record<string, string[]>;
}) {
  useI18n();
  const [edit, setEdit] = useState<{ folder: LibraryFolder | null; revision: number } | null>(null);
  const [title, setTitle] = useState('');
  const [coverFolderId, setCoverFolderId] = useState<string | null>(null);
  const newFolderButton = useRef<HTMLButtonElement>(null);
  const { organization, busy, mutate } = organizer;
  function openEdit(folder: LibraryFolder | null) {
    if (!organization) return;
    setTitle(folder?.title ?? '');
    setEdit({ folder, revision: organization.revision });
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
            endpoint={libraryEndpoints.deleteFolder}
            params={{ id: folder.id }}
            revision={organization?.revision}
            title={folder.title}
            label={t('library.deleteFolder')}
            description={t('library.resourcesInThisFolderWillMoveTo')}
            disabled={busy}
            onError={(message) => {
              onError(message);
              void reload();
            }}
            onDeleted={async () => {
              await reload();
              newFolderButton.current?.focus();
            }}
          />
        </div>
      </>
    );
  }
  const coverFolder = organization?.folders.find((item) => item.id === coverFolderId);
  const dialogs = (
    <>
      <LibraryFolderCoverDialog
        folder={coverFolder}
        portraits={coverFolder ? covers?.[coverFolder.id] : undefined}
        busy={busy}
        onApply={(coverImageHash) =>
          mutate(libraryEndpoints.updateFolder, { id: coverFolder!.id, coverImageHash })
        }
        onClose={() => setCoverFolderId(null)}
      />
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
            const success = edit.folder
              ? await mutate(
                  libraryEndpoints.updateFolder,
                  { id: edit.folder.id, title: title.trim() },
                  edit.revision
                )
              : await mutate(
                  libraryEndpoints.createFolder,
                  { title: title.trim(), category },
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
    </>
  );
  return { newFolderButton, openNew: () => openEdit(null), folderActions, dialogs };
}
type LibraryFolderEditor = ReturnType<typeof useLibraryFolderEditor>;

export function useLibraryItemDrag({
  category,
  organizer,
  folderOf,
  manual,
  sectioned,
  disabled,
  onReorder,
}: {
  category: LibraryCategory;
  organizer: LibraryOrganizer;
  folderOf: (id: string) => string | null;
  manual: boolean;
  sectioned: boolean;
  disabled: boolean;
  onReorder: (id: string, beforeId: string) => void;
}) {
  const dragged = useRef<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const folderTarget = (folderId: string | null) => `folder:${folderId ?? ''}`;
  function clear() {
    dragged.current = null;
    setDraggedId(null);
    setTarget(null);
  }
  function move(id: string, folderId: string | null) {
    if (folderOf(id) === folderId) return;
    void organizer.mutate(libraryEndpoints.moveItems, moveInput([id], category, folderId));
  }
  function overFolder(folderId: string | null, event: DragEvent<HTMLElement>) {
    const source = dragged.current;
    if (!source || folderOf(source) === folderId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setTarget(folderTarget(folderId));
  }
  function leaveFolder(folderId: string | null, event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setTarget((current) => (current === folderTarget(folderId) ? null : current));
  }
  function dropOnFolder(folderId: string | null, event: DragEvent<HTMLElement>) {
    const source = dragged.current;
    if (!source) return;
    event.preventDefault();
    clear();
    move(source, folderId);
  }
  return {
    draggedId,
    overFolder,
    leaveFolder,
    dropOnFolder,
    targetsFolder: (folderId: string | null) => target === folderTarget(folderId),
    item: (id: string) => ({
      draggable: !disabled && !organizer.busy,
      'data-dragging': draggedId === id ? ('true' as const) : undefined,
      'data-drop-target': target === `item:${id}` ? ('true' as const) : undefined,
      onDragStart: (event: DragEvent<HTMLElement>) => {
        if (disabled || organizer.busy || (event.target as HTMLElement).closest('.action-menu')) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', id);
        dragged.current = id;
        setDraggedId(id);
      },
      onDragEnd: clear,
      onDragOver: (event: DragEvent<HTMLElement>) => {
        const source = dragged.current;
        if (!manual || !source || source === id) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        setTarget(`item:${id}`);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const source = dragged.current;
        if (!manual || !source || source === id) return;
        event.preventDefault();
        event.stopPropagation();
        clear();
        if (sectioned) move(source, folderOf(id));
        onReorder(source, id);
      },
    }),
    folder: (folderId: string | null) => ({
      'data-drop-target': target === folderTarget(folderId) ? ('true' as const) : undefined,
      onDragOver: (event: DragEvent<HTMLElement>) => overFolder(folderId, event),
      onDragLeave: (event: DragEvent<HTMLElement>) => leaveFolder(folderId, event),
      onDrop: (event: DragEvent<HTMLElement>) => dropOnFolder(folderId, event),
    }),
  };
}
type LibraryItemDrag = ReturnType<typeof useLibraryItemDrag>;

export function LibraryFolderChips({
  category,
  organizer,
  value,
  onChange,
  counts,
  total,
  editor,
  itemDrag,
}: {
  category: LibraryCategory;
  organizer: LibraryOrganizer;
  value: FolderFilter;
  onChange: (value: FolderFilter) => void;
  counts: Record<string, number>;
  total: number;
  editor: LibraryFolderEditor;
  itemDrag: LibraryItemDrag;
}) {
  useI18n();
  const draggedFolder = useRef<string | null>(null);
  const [folderDrop, setFolderDrop] = useState<{ id: string; edge: 'before' | 'after' } | null>(
    null
  );
  const { organization, busy, mutate } = organizer;
  const folders = sortedFolders(organization, category);
  function clearFolderDrag() {
    draggedFolder.current = null;
    setFolderDrop(null);
  }
  function edgeOf(event: DragEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left + bounds.width / 2
      ? ('before' as const)
      : ('after' as const);
  }
  function dropFolder(folderId: string, event: DragEvent<HTMLElement>) {
    const id = draggedFolder.current;
    if (!id) {
      itemDrag.dropOnFolder(folderId, event);
      return;
    }
    event.preventDefault();
    const remaining = folders.filter((folder) => folder.id !== id);
    const index = remaining.findIndex((folder) => folder.id === folderId);
    const beforeFolderId =
      edgeOf(event) === 'before' ? folderId : (remaining[index + 1]?.id ?? null);
    clearFolderDrag();
    if (id === folderId || busy) return;
    void mutate(libraryEndpoints.updateFolder, { id, beforeFolderId });
  }
  return (
    <div className="library-folder-bar">
      <ScrollStrip
        className="library-folder-chips"
        role="group"
        aria-label={t('library.folders2', { v0: t(categoryLabelKeys[category]) })}
      >
        <button
          type="button"
          className="library-folder-chip"
          aria-pressed={value === 'all'}
          onClick={() => onChange('all')}
        >
          <span>{t('library.all')}</span>
          <small>{total}</small>
        </button>
        {folders.map((folder) => (
          <div
            className="library-folder-chip-slot"
            key={folder.id}
            data-folder-id={folder.id}
            data-drop-target={itemDrag.targetsFolder(folder.id) ? 'true' : undefined}
            data-drop-position={folderDrop?.id === folder.id ? folderDrop.edge : undefined}
            draggable={!busy}
            onDragStart={(event) => {
              draggedFolder.current = folder.id;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', folder.title);
            }}
            onDragEnd={clearFolderDrag}
            onDragOver={(event) => {
              if (!draggedFolder.current) {
                itemDrag.overFolder(folder.id, event);
                return;
              }
              if (draggedFolder.current === folder.id || busy) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setFolderDrop({ id: folder.id, edge: edgeOf(event) });
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setFolderDrop(null);
              itemDrag.leaveFolder(folder.id, event);
            }}
            onDrop={(event) => dropFolder(folder.id, event)}
          >
            <button
              type="button"
              className="library-folder-chip"
              aria-pressed={value === folder.id}
              onClick={() => onChange(folder.id)}
            >
              <span title={folder.title}>{folder.title}</span>
              <small>{counts[folder.id] ?? 0}</small>
            </button>
          </div>
        ))}
      </ScrollStrip>
      <IconButton
        ref={editor.newFolderButton}
        icon={FolderAddIcon}
        label={t('library.newFolder')}
        className="secondary"
        disabled={busy || !organization}
        onClick={editor.openNew}
      />
    </div>
  );
}

export function LibraryFolderSection({
  folder,
  title,
  count,
  covers,
  collapsed = false,
  onToggle,
  menu,
  drop,
  children,
}: {
  folder: LibraryFolder | null;
  title: string;
  count: number;
  covers?: string[];
  collapsed?: boolean;
  onToggle?: () => void;
  menu?: ReactNode;
  drop?: ReturnType<LibraryItemDrag['folder']>;
  children: ReactNode;
}) {
  useI18n();
  const headingId = useId();
  const bodyId = useId();
  const label = (
    <>
      {folder && (
        <LibraryFolderCover
          coverImageHash={folder.coverImageHash}
          portraits={covers}
          iconSize={20}
        />
      )}
      <span className="library-section-name">{title}</span>
      <small>{t('library.itemCount', { count })}</small>
    </>
  );
  return (
    <section
      className="library-section"
      data-folder-section={folder?.id ?? ''}
      aria-labelledby={headingId}
      {...drop}
    >
      <div className="library-section-heading">
        <h2 id={headingId}>
          {onToggle ? (
            <button
              type="button"
              className="library-section-toggle"
              aria-expanded={!collapsed}
              aria-controls={collapsed ? undefined : bodyId}
              onClick={onToggle}
            >
              <ExpandIcon className="library-section-chevron" size={16} aria-hidden="true" />
              {label}
            </button>
          ) : (
            label
          )}
        </h2>
        {menu}
      </div>
      {!collapsed && (
        <div id={bodyId} className="library-section-body">
          {children}
        </div>
      )}
    </section>
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
              libraryEndpoints.moveItems,
              moveInput(
                items.map((item) => item.id),
                destination,
                folderId || null
              ),
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
