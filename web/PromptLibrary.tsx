import { useI18n, registerMessage, message as uiMessage, messageRef } from './i18n.js';
import { IconButton } from './IconButton.js';
import { MessageCircle } from 'lucide-react';
import { LoadingState } from './LoadingState.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  AddIcon,
  BackIcon,
  CopyIcon,
  DownIcon,
  UpIcon,
  EditIcon,
  MoveIcon,
  OptionsIcon,
  PromptIcon,
  SearchIcon,
  SelectIcon,
  SettingsIcon,
} from './ui-icons.js';
import type { Library, PromptPreset, PromptPresetSummary, PromptRole } from '../core/product.js';
import type { ResourceSaveResult } from '../core/resource-editing.js';
import type { LibraryItemKey, LibraryOrganization } from '../core/library-organization.js';
import { libraryFolderOf } from '../core/library-organization.js';
import { api, ApiError } from './api.js';
import { Dialog } from './Dialog.js';
import { DeleteButton } from './DeleteButton.js';
import { PromptEditor } from './PromptEditor.js';
import { RisuPresetImport } from './RisuPresetImport.js';
import { PromptTemplatesDialog, type PromptTemplate } from './PromptTemplatesDialog.js';
import {
  discardActiveEditor,
  saveActiveEditor,
  ResourceEditorLeaveWarning,
} from './resource-editor.js';
import {
  LibraryFolders,
  LibraryItemMenu,
  LibraryMoveDialog,
  useLibraryOrganization,
  type FolderFilter,
} from './LibraryFolders.js';
import './library.css';
import {
  saveLibrarySort,
  saveLibraryManualOrder,
  type LibrarySort,
} from './library-list-preferences.js';

type PromptSort = LibrarySort;
function savedPromptSort(): PromptSort {
  try {
    const value = JSON.parse(localStorage.getItem('uimori-library-sorts') ?? '{}').prompts;
    if (value === 'name' || value === 'name-desc' || value === 'manual') return value;
  } catch {
    /* Keep a sensible default in restricted browsers. */
  }
  return 'name';
}
function savedPromptOrder(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem('uimori-library-manual-orders') ?? '{}').prompts;
    if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string');
  } catch {
    /* Keep a sensible default in restricted browsers. */
  }
  return [];
}

export function PromptLibrary({
  library,
  reload,
  onError,
  onDirtyChange,
  headerLeading,
  headerTrailing,
  onOpenCurrentPrompts,
  onAskHelper,
  onEditorOpened,
  initialPresetId,
  onInitialPresetHandled,
  listRequest = 0,
}: {
  library: Library | null;
  reload: () => Promise<void>;
  onError: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  headerLeading?: ReactNode;
  headerTrailing?: ReactNode;
  onOpenCurrentPrompts: () => void;
  onAskHelper: (preset: PromptPresetSummary) => void;
  onEditorOpened: () => void;
  initialPresetId?: string | null;
  onInitialPresetHandled?: () => void;
  /** Bumped when the navigation entry is chosen, so an open editor returns to the list. */
  listRequest?: number;
}) {
  const { t, locale } = useI18n();
  const [folder, setFolder] = useState<FolderFilter>('all');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'all' | PromptRole>('all');
  const [sort, setSort] = useState<PromptSort>(savedPromptSort);
  const [manualOrder, setManualOrder] = useState(savedPromptOrder);
  const draggedItem = useRef<string | null>(null);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ kind: 'item' | 'folder'; id: string } | null>(
    null
  );
  const [editing, setEditing] = useState<{ preset: PromptPreset | null; role: PromptRole } | null>(
    null
  );
  const pendingEditing = useRef<typeof editing>(null);
  useEffect(() => {
    // A card-pinned saved reference must never mask a newly opened editor draft.
    if (editing) onEditorOpened();
  }, [editing, onEditorOpened]);
  const handledPreset = useRef<string | null>(null);
  useEffect(() => {
    if (!initialPresetId) {
      handledPreset.current = null;
      return;
    }
    if (!library || handledPreset.current === initialPresetId) return;
    handledPreset.current = initialPresetId;
    const preset = library.promptPresets?.find((item) => item.id === initialPresetId);
    if (preset)
      void api<PromptPreset>(`/prompt-presets/${encodeURIComponent(preset.id)}`)
        .then((full) => {
          if (handledPreset.current === initialPresetId) {
            setEditing({ preset: full, role: full.role });
            onInitialPresetHandled?.();
          }
        })
        .catch((cause) => {
          onError((cause as Error).message);
          onInitialPresetHandled?.();
        });
    else {
      onError(uiMessage('prompts.uiSelectedPromptNotFound'));
      onInitialPresetHandled?.();
    }
  }, [initialPresetId, library, onError, onInitialPresetHandled]);

  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [savingNavigation, setSavingNavigation] = useState(false);
  const externalList = useRef(listRequest);
  const [moving, setMoving] = useState<LibraryItemKey[] | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const organizer = useLibraryOrganization(library, reload, onError);
  const mutation = useRef(false);
  const [busy, setBusy] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const createdPresetFocus = useRef<string | null>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const organized = library
    ? { ...library, organization: organizer.organization ?? library.organization }
    : null;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!editing?.preset || createdPresetFocus.current !== editing.preset.id) return;
    createdPresetFocus.current = null;
    const frame = requestAnimationFrame(() => editorHeading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editing]);
  useEffect(() => {
    if (
      folder !== 'all' &&
      folder !== 'unclassified' &&
      organizer.organization &&
      !organizer.organization.folders.some(
        (item) => item.id === folder && item.category === 'prompts'
      )
    )
      setFolder('all');
  }, [folder, organizer.organization]);
  useEffect(() => {
    const currentLibrary = library
      ? { ...library, organization: organizer.organization ?? library.organization }
      : null;
    const available = new Set(
      library?.promptPresets
        ?.filter((item) => {
          const folderId = libraryFolderOf(currentLibrary!, { kind: 'prompt-preset', id: item.id });
          return (
            folder === 'all' ||
            (folder === 'unclassified' ? folderId === null : folderId === folder)
          );
        })
        .map((item) => item.id) ?? []
    );
    setSelection((current) => current.filter((id) => available.has(id)));
    setMoving((current) => (current?.some((item) => !available.has(item.id)) ? null : current));
  }, [library, organizer.organization, folder]);
  const presets = library?.promptPresets ?? [];
  const counts: Record<string, number> = { all: presets.length };
  for (const preset of presets) {
    const key =
      libraryFolderOf(organized!, { kind: 'prompt-preset', id: preset.id }) ?? 'unclassified';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const filtered = presets
    .filter((item) => {
      const folderId = libraryFolderOf(organized!, { kind: 'prompt-preset', id: item.id });
      return (
        (folder === 'all' ||
          (folder === 'unclassified' ? folderId === null : folderId === folder)) &&
        (role === 'all' || item.role === role) &&
        item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      );
    })
    .sort((a, b) => {
      if (sort !== 'manual')
        return (sort === 'name-desc' ? -1 : 1) * a.title.localeCompare(b.title, locale);
      const aIndex = manualOrder.indexOf(a.id);
      const bIndex = manualOrder.indexOf(b.id);
      return (
        (aIndex < 0 ? Number.MAX_SAFE_INTEGER : aIndex) -
          (bIndex < 0 ? Number.MAX_SAFE_INTEGER : bIndex) || a.title.localeCompare(b.title, locale)
      );
    });
  const folders =
    organizer.organization?.folders.filter((item) => item.category === 'prompts') ?? [];
  const showFolders = folder === 'all' && !query.trim() && !selecting;
  const categoryEmpty = !!library && presets.length === 0 && !query;
  function changeSort(next: PromptSort) {
    setSort(next);
    saveLibrarySort('prompts', next);
  }
  function moveManualItem(id: string, beforeId: string | null) {
    const available = new Set(presets.map((item) => item.id));
    const ordered = [
      ...manualOrder.filter((itemId) => available.has(itemId)),
      ...presets
        .filter((item) => !manualOrder.includes(item.id))
        .sort((a, b) => a.title.localeCompare(b.title, locale))
        .map((item) => item.id),
    ].filter((itemId) => itemId !== id);
    const index = beforeId === null ? ordered.length : ordered.indexOf(beforeId);
    ordered.splice(index < 0 ? ordered.length : index, 0, id);
    setManualOrder(ordered);
    saveLibraryManualOrder('prompts', ordered);
  }
  function moveByOffset(id: string, offset: number) {
    const index = filtered.findIndex((item) => item.id === id);
    const target = filtered[index + offset];
    if (target) moveManualItem(id, offset < 0 ? target.id : (filtered[index + 2]?.id ?? null));
  }
  function clearDragging() {
    draggedItem.current = null;
    setDraggedItemId(null);
    setDropTarget(null);
  }
  function startDragging(id: string, event: DragEvent<HTMLElement>) {
    if (
      selecting ||
      organizer.busy ||
      busy ||
      (event.target as HTMLElement).closest('.action-menu')
    ) {
      event.preventDefault();
      return;
    }
    draggedItem.current = id;
    setDraggedItemId(id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }
  function dragOverItem(id: string, event: DragEvent<HTMLElement>) {
    if (sort !== 'manual' || !draggedItem.current || draggedItem.current === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget({ kind: 'item', id });
  }
  function dropOnItem(id: string, event: DragEvent<HTMLElement>) {
    const source = draggedItem.current;
    if (sort !== 'manual' || !source || source === id) return;
    event.preventDefault();
    moveManualItem(source, id);
    clearDragging();
  }
  function dragOverFolder(id: string, event: DragEvent<HTMLElement>) {
    if (!draggedItem.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget({ kind: 'folder', id });
  }
  function dragLeaveFolder(id: string, event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropTarget((current) => (current?.kind === 'folder' && current.id === id ? null : current));
  }
  async function dropOnFolder(folderId: string, event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const id = draggedItem.current;
    clearDragging();
    if (!id || !organized || libraryFolderOf(organized, { kind: 'prompt-preset', id }) === folderId)
      return;
    await organizer.mutate('/library/organization/move', {
      items: [{ kind: 'prompt-preset', id }],
      category: 'prompts',
      folderId,
    });
  }
  async function editPreset(item: PromptPresetSummary) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    try {
      const preset = await api<PromptPreset>(`/prompt-presets/${encodeURIComponent(item.id)}`);
      changeEditing({ preset, role: preset.role });
    } catch (cause) {
      onError((cause as Error).message);
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  function changeEditing(next: typeof editing) {
    pendingEditing.current = next;
    if (dirty) setDiscard(true);
    else setEditing(next);
  }
  function close() {
    changeEditing(null);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only an explicit request leaves the editor.
  useEffect(() => {
    if (externalList.current === listRequest) return;
    externalList.current = listRequest;
    // `changeEditing` keeps the existing unsaved-draft confirmation.
    if (editing) close();
  }, [listRequest]);
  async function placeCreated(preset: PromptPreset, created: boolean) {
    if (!created || folder === 'all' || folder === 'unclassified') return;
    const current = await api<LibraryOrganization>('/library/organization');
    const placed = await organizer.mutate(
      '/library/organization/move',
      { items: [{ kind: 'prompt-preset', id: preset.id }], category: 'prompts', folderId: folder },
      'POST',
      current.revision
    );
    if (!placed) throw new Error(uiMessage('prompts.uiUnableToPlaceTheItemInTheFolder'));
  }
  async function clone(item: PromptPresetSummary) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    try {
      const result = await api<ResourceSaveResult>('/resources/clone', {
        kind: 'prompt-preset',
        sourceId: item.id,
        expectedSourceRevision: item.revision,
        title: `${item.title.slice(0, 197).replace(/[\uD800-\uDBFF]$/u, '')} 사본`,
      });
      const copy = result.saved as PromptPreset;
      const warnings: (() => string)[] = [];
      try {
        await placeCreated(copy, true);
      } catch (error) {
        warnings.push(() =>
          t('prompts.clonedPlacement', {
            error:
              error instanceof ApiError
                ? error.displayMessage
                : messageRef((error as Error).message),
          })
        );
      }
      try {
        await reload();
      } catch (error) {
        warnings.push(() =>
          t('prompts.clonedReload', {
            error:
              error instanceof ApiError
                ? error.displayMessage
                : messageRef((error as Error).message),
          })
        );
      }
      if (warnings.length) {
        const renderWarnings = () => warnings.map((render) => render()).join('\n');
        const warning = renderWarnings();
        registerMessage(warning, renderWarnings);
        onError(warning);
      }
    } catch (error) {
      onError((error as Error).message);
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function addTemplate(id: string): Promise<PromptPreset | null> {
    if (mutation.current) return null;
    mutation.current = true;
    setBusy(true);
    try {
      const template = await api<PromptTemplate>(`/prompt-templates/${encodeURIComponent(id)}`);
      const created = await api<PromptPreset>('/prompt-presets', {
        title: template.title,
        role: template.role,
        program: template.program,
        values: template.values,
      });
      // Creation is complete. A later placement/reload failure must not offer another POST.
      try {
        await placeCreated(created, true);
      } catch (error) {
        const renderWarning = () =>
          t('prompts.addedPlacement', {
            error:
              error instanceof ApiError
                ? error.displayMessage
                : messageRef((error as Error).message),
          });
        const warning = renderWarning();
        registerMessage(warning, renderWarning);
        onError(warning);
      }
      try {
        await reload();
      } catch (error) {
        const renderWarning = () =>
          t('prompts.addedReload', {
            error:
              error instanceof ApiError
                ? error.displayMessage
                : messageRef((error as Error).message),
          });
        const warning = renderWarning();
        registerMessage(warning, renderWarning);
        onError(warning);
      }
      return created;
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className={`library-page prompt-library${editing ? ' library-page-editing' : ''}`}
      aria-label={t('prompts.uiManagePrompts')}
      data-testid="prompt-library"
    >
      <header className="library-heading" hidden={!!editing}>
        {headerLeading}
        <h1>{t('prompts.uiPrompts')}</h1>
        {headerTrailing}
      </header>
      <PromptTemplatesDialog
        open={templatesOpen}
        busy={busy}
        onClose={() => setTemplatesOpen(false)}
        onAdd={addTemplate}
        onAdded={(preset) => {
          setTemplatesOpen(false);
          createdPresetFocus.current = preset.id;
          changeEditing({ preset, role: preset.role });
        }}
        onError={onError}
      />
      <Dialog
        open={discard}
        title={t('prompts.uiUnsavedPrompt')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (!savingNavigation) setDiscard(false);
        }}
      >
        <p>{t('prompts.uiLeavingWillDiscardUnsavedPromptEdits')}</p>
        <ResourceEditorLeaveWarning />
        <DraftDiscardActions
          open={discard}
          onSavingChange={setSavingNavigation}
          onContinue={() => setDiscard(false)}
          onSave={async () => {
            const destination = pendingEditing.current;
            if (!(await saveActiveEditor())) return false;
            setDiscard(false);
            setDirty(false);
            setEditing(destination);
            return true;
          }}
          onDiscard={async () => {
            try {
              await discardActiveEditor();
              setDiscard(false);
              setDirty(false);
              setEditing(pendingEditing.current);
            } catch (error) {
              onError((error as Error).message);
            }
          }}
          discardLabel={t('prompts.uiDiscardDraftAndLeave')}
        />
      </Dialog>
      <LibraryMoveDialog
        items={moving}
        category="prompts"
        organizer={organizer}
        onClose={() => setMoving(null)}
        onMoved={() => {
          setMoving(null);
          setSelection([]);
          setSelecting(false);
        }}
      />
      {!library ? (
        <LoadingState presentation="region" label={t('prompts.uiLoadingPrompts')} />
      ) : editing ? (
        <div className="library-prompt-editor">
          <PromptEditor
            heading={
              <>
                {headerLeading}
                <IconButton
                  className="secondary"
                  label={t('prompts.uiPromptList')}
                  icon={BackIcon}
                  onClick={close}
                />
                <h2 ref={editorHeading} tabIndex={-1}>
                  {editing.preset?.title ?? t('prompts.uiNewPrompt')}
                </h2>
              </>
            }
            headingTrailing={headerTrailing}
            key={
              editing.preset
                ? `${editing.preset.id}@${editing.preset.revision}`
                : `new-${editing.role}`
            }
            library={library}
            reload={reload}
            onError={onError}
            onDirtyChange={setDirty}
            initialRole={editing.role}
            initialPreset={editing.preset}
            onSaved={placeCreated}
          />
        </div>
      ) : (
        <div className="library-workspace">
          <div className="library-workspace-content">
            <div className="library-toolbar">
              {!selecting && (
                <LibraryFolders
                  presentation="breadcrumb"
                  category="prompts"
                  organizer={organizer}
                  value={folder}
                  onChange={(next) => {
                    setFolder(next);
                    setSelection([]);
                  }}
                  counts={counts}
                  reload={reload}
                  onError={onError}
                />
              )}
              {selecting ? (
                <div
                  className="library-bulk-toolbar"
                  role="group"
                  aria-label={t('prompts.uiPromptSelectionActions')}
                >
                  <span role="status">
                    {t('prompts.selectedCount', { count: selection.length })}
                  </span>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={t('prompts.uiSelectAllDisplayedPrompts')}
                    onClick={() => setSelection(filtered.map((item) => item.id))}
                  >
                    <SelectIcon size={18} aria-hidden="true" />
                    <span>{t('prompts.uiSelectAll')}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('prompts.uiMoveSelectedPrompts')}
                    disabled={!selection.length || organizer.busy}
                    onClick={() =>
                      setMoving(selection.map((id) => ({ kind: 'prompt-preset', id })))
                    }
                  >
                    <MoveIcon size={18} aria-hidden="true" />
                    <span>{t('prompts.uiMove')}</span>
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setSelecting(false);
                      setSelection([]);
                    }}
                  >
                    {t('prompts.uiDone')}
                  </button>
                </div>
              ) : (
                !categoryEmpty && (
                  <>
                    <label className="library-search-field">
                      <SearchIcon size={20} aria-hidden="true" />
                      <span className="sr-only">{t('prompts.uiSearchPrompts')}</span>
                      <input
                        type="search"
                        aria-label={t('prompts.uiSearchPrompts')}
                        placeholder={t('prompts.uiSearchByName')}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                    <LibraryItemMenu
                      title={t('prompts.uiManageList')}
                      className="library-list-options"
                      icon={OptionsIcon}
                    >
                      <div className="library-list-options-body">
                        <label>
                          {t('prompts.uiRole')}
                          <select
                            aria-label={t('prompts.uiFilterPromptRoles')}
                            value={role}
                            onChange={(event) => setRole(event.target.value as typeof role)}
                          >
                            <option value="all">{t('prompts.uiAllRoles')}</option>
                            <option value="main">{t('prompts.uiWriting')}</option>
                            <option value="translation">{t('prompts.uiTranslation')}</option>
                          </select>
                        </label>
                        <label>
                          {t('prompts.uiSort')}
                          <select
                            aria-label={t('prompts.uiSortPrompts')}
                            value={sort}
                            onChange={(event) => changeSort(event.target.value as PromptSort)}
                          >
                            <option value="name">{t('prompts.uiNameAscending')}</option>
                            <option value="name-desc">{t('prompts.uiNameDescending')}</option>
                            <option value="manual">{t('prompts.uiManualOrder')}</option>
                          </select>
                        </label>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setSelecting(true);
                            setSelection([]);
                          }}
                        >
                          <SelectIcon size={18} aria-hidden="true" />
                          {t('prompts.uiSelect')}
                        </button>
                      </div>
                    </LibraryItemMenu>
                  </>
                )
              )}
              {!selecting && library && (
                <div className="prompt-library-actions">
                  <RisuPresetImport
                    showTrigger
                    reload={reload}
                    onImported={(preset) => {
                      createdPresetFocus.current = preset.id;
                      changeEditing({ preset, role: preset.role });
                    }}
                  />
                  <button
                    type="button"
                    className="secondary prompt-settings-link ui-icon-button"
                    aria-label={t('prompts.uiCurrentPromptSettings')}
                    title={t('prompts.uiCurrentPromptSettings')}
                    onClick={onOpenCurrentPrompts}
                  >
                    <SettingsIcon size={18} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="secondary prompt-templates-open ui-icon-button"
                    aria-label={t('prompts.uiBuiltInPrompts')}
                    title={t('prompts.uiBuiltInPrompts')}
                    disabled={busy || organizer.busy}
                    onClick={() => setTemplatesOpen(true)}
                  >
                    <PromptIcon size={18} aria-hidden="true" />
                  </button>
                </div>
              )}
              {!selecting && (
                <button
                  type="button"
                  className={`library-create${categoryEmpty ? ' secondary' : ' primary'}`}
                  aria-label={t('prompts.uiNewPrompt')}
                  title={t('prompts.uiNewPrompt')}
                  disabled={!library}
                  onClick={() =>
                    changeEditing({ preset: null, role: role === 'translation' ? role : 'main' })
                  }
                >
                  <AddIcon size={18} aria-hidden="true" /> <span>{t('prompts.uiNewPrompt')}</span>
                </button>
              )}
            </div>
            {!!query && !selecting && (
              <p className="library-result-count muted" role="status">
                {t('prompts.searchCount', { count: filtered.length })}
              </p>
            )}
            {showFolders && folders.length > 0 && (
              <section className="library-folder-section" aria-label={t('prompts.uiFolderList')}>
                <h2>{t('prompts.uiFolders')}</h2>
                <LibraryFolders
                  presentation="cards"
                  draggedItemId={draggedItemId}
                  dropFolderId={dropTarget?.kind === 'folder' ? dropTarget.id : null}
                  onFolderDragOver={dragOverFolder}
                  onFolderDragLeave={dragLeaveFolder}
                  onFolderDrop={(id, event) => void dropOnFolder(id, event)}
                  category="prompts"
                  organizer={organizer}
                  value={folder}
                  onChange={(next) => {
                    setFolder(next);
                    setSelection([]);
                  }}
                  counts={counts}
                  reload={reload}
                  onError={onError}
                />
              </section>
            )}
            {showFolders && folders.length > 0 && (
              <h2 className="library-section-title">{t('prompts.uiAllPrompts')}</h2>
            )}

            <div className="library-list">
              {filtered.map((item) => (
                <article
                  className="library-list-item"
                  key={item.id}
                  data-library-item-id={item.id}
                  data-dragging={draggedItemId === item.id ? 'true' : undefined}
                  data-drop-target={
                    dropTarget?.kind === 'item' && dropTarget.id === item.id ? 'true' : undefined
                  }
                  draggable={!selecting && !organizer.busy && !busy}
                  onDragStart={(event) => startDragging(item.id, event)}
                  onDragEnd={clearDragging}
                  onDragOver={(event) => dragOverItem(item.id, event)}
                  onDrop={(event) => dropOnItem(item.id, event)}
                >
                  {selecting && (
                    <label className="library-select-check">
                      <span className="sr-only">
                        {t('prompts.selectNamed', { name: item.title })}
                      </span>
                      <SelectionCheckbox
                        aria-label={t('prompts.selectNamed', { name: item.title })}
                        checked={selection.includes(item.id)}
                        onChange={(event) =>
                          setSelection((current) =>
                            event.target.checked
                              ? [...current, item.id]
                              : current.filter((id) => id !== item.id)
                          )
                        }
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    className="library-open-content"
                    aria-label={t('prompts.editNamed', { name: item.title })}
                    onClick={() => void editPreset(item)}
                  >
                    <span className="library-prompt-icon" aria-hidden="true">
                      <PromptIcon size={20} />
                    </span>
                    <span className="library-item-copy">
                      <strong>{item.title}</strong>
                      <span>{t('prompts.rolePrompt', { role: item.role })}</span>
                    </span>
                  </button>
                  <LibraryItemMenu title={t('prompts.menuNamed', { name: item.title })}>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void editPreset(item)}
                    >
                      <EditIcon size={18} aria-hidden="true" />
                      {t('prompts.uiEdit2')}
                    </button>
                    <button type="button" className="secondary" onClick={() => onAskHelper(item)}>
                      <MessageCircle size={18} aria-hidden="true" />
                      {t('prompts.uiAskHelper')}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={organizer.busy}
                      onClick={() => setMoving([{ kind: 'prompt-preset', id: item.id }])}
                    >
                      <MoveIcon size={18} aria-hidden="true" />
                      {t('prompts.uiMoveToFolder')}
                    </button>
                    {sort === 'manual' && (
                      <>
                        <button
                          type="button"
                          className="secondary"
                          disabled={filtered[0]?.id === item.id}
                          onClick={() => moveByOffset(item.id, -1)}
                        >
                          <UpIcon size={18} aria-hidden="true" />
                          {t('prompts.uiMoveUp')}
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          disabled={filtered.at(-1)?.id === item.id}
                          onClick={() => moveByOffset(item.id, 1)}
                        >
                          <DownIcon size={18} aria-hidden="true" />
                          {t('prompts.uiMoveDown')}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void clone(item)}
                    >
                      <CopyIcon size={18} aria-hidden="true" />
                      {t('prompts.uiDuplicate')}
                    </button>
                    <DeleteButton
                      path={`/prompt-presets/${encodeURIComponent(item.id)}`}
                      revision={item.revision}
                      title={item.title}
                      onDeleted={reload}
                      onError={onError}
                    />
                  </LibraryItemMenu>
                </article>
              ))}
            </div>
            {!filtered.length && (
              <div className="library-empty">
                <h2>{query ? t('prompts.uiNoMatchingPrompts') : t('prompts.uiNoPromptsYet')}</h2>
                <p>{t('prompts.uiCreateInstructionsForWritingAndTranslation')}</p>
                {folder !== 'all' && (
                  <button type="button" className="secondary" onClick={() => setFolder('all')}>
                    {t('prompts.uiSearchAll')}
                  </button>
                )}
                <button
                  type="button"
                  className="library-create"
                  onClick={() =>
                    changeEditing({ preset: null, role: role === 'translation' ? role : 'main' })
                  }
                >
                  {t('prompts.uiNewPrompt')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
