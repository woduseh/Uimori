import { useI18n, message as descriptor, messageRef } from './i18n.js';
import { IconButton } from './IconButton.js';
import { LoadingState } from './LoadingState.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { ScrollStrip } from './ScrollStrip.js';
import { TransientNotice } from './TransientNotice.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AddIcon,
  BackIcon,
  CheckIcon,
  CopyIcon,
  DownIcon,
  UpIcon,
  EditIcon,
  HelperIcon,
  MoveIcon,
  PromptIcon,
  SearchIcon,
  SelectIcon,
  SettingsIcon,
  SortIcon,
  TemplateIcon,
} from './ui-icons.js';
import type { Library, PromptPreset, PromptPresetSummary, PromptRole } from '../core/product.js';
import type { LibraryItemKey } from '../core/library-organization.js';
import {
  deletionEndpoints,
  libraryEndpoints,
  promptEndpoints,
  resourceEditorEndpoints,
} from '#contracts';
import { api, callEndpoint } from './api.js';
import { Dialog } from './Dialog.js';
import { DeleteButton } from './DeleteButton.js';
import { PromptEditor } from './PromptEditor.js';
import { RisuPresetImport } from './RisuPresetImport.js';
import { PromptTemplatesDialog, type PromptTemplate } from './PromptTemplatesDialog.js';
import { usePromptWorkspace } from './usePromptWorkspace.js';
import {
  discardActiveEditor,
  saveActiveEditor,
  ResourceEditorLeaveWarning,
} from './resource-editor.js';
import {
  LibraryFolderChips,
  LibraryFolderSection,
  LibraryItemMenu,
  LibraryMoveDialog,
  sortedFolders,
  useCollapsedFolders,
  useLibraryFolderEditor,
  useLibraryItemDrag,
  useLibraryOrganization,
  type FolderFilter,
} from './LibraryFolders.js';
import {
  librarySections,
  libraryPlacements,
  neighbourTarget,
  placementOf,
  reorderManually,
  sortLibraryItems,
} from './library-list.js';
import './library.css';
import {
  saveLibrarySort,
  saveLibraryManualOrder,
  type LibrarySort,
} from './library-list-preferences.js';
import { readOptionalJson } from './optional-storage.js';
import { storageKeys } from './storage-keys.js';

type PromptSort = LibrarySort;
function savedPromptPreference(key: string) {
  return (readOptionalJson('local', key, null) as { prompts?: unknown } | null)?.prompts;
}
function savedPromptSort(): PromptSort {
  const value = savedPromptPreference(storageKeys.librarySorts);
  if (value === 'name' || value === 'name-desc' || value === 'manual') return value;
  return 'name';
}
function savedPromptOrder(): string[] {
  const value = savedPromptPreference(storageKeys.libraryManualOrders);
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string');
  return [];
}

const promptRoleTabs = [
  { id: 'all', titleKey: 'prompts.uiAllRoles' },
  { id: 'main', titleKey: 'prompts.uiWriting' },
  { id: 'translation', titleKey: 'prompts.uiTranslation' },
] as const;
type PromptRoleFilter = (typeof promptRoleTabs)[number]['id'];

export function PromptLibrary({
  library,
  reload,
  onError,
  onDirtyChange,
  onEditingChange,
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
  onEditingChange?: (editing: boolean) => void;
  headerLeading?: ReactNode;
  headerTrailing?: ReactNode;
  onOpenCurrentPrompts: () => void;
  onAskHelper: (preset: PromptPresetSummary) => void;
  onEditorOpened: () => void;
  initialPresetId?: string | null;
  onInitialPresetHandled?: () => void;
  listRequest?: number;
}) {
  const { t, locale } = useI18n();
  const [folder, setFolder] = useState<FolderFilter>('all');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<PromptRoleFilter>('all');
  const [sort, setSort] = useState<PromptSort>(savedPromptSort);
  const [manualOrder, setManualOrder] = useState(savedPromptOrder);
  const [editing, setEditing] = useState<{ preset: PromptPreset | null; role: PromptRole } | null>(
    null
  );
  const pendingEditing = useRef<typeof editing>(null);
  useEffect(() => {
    if (editing) onEditorOpened();
  }, [editing, onEditorOpened]);
  const handledPreset = useRef<string | null>(null);
  const opening = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The requested preset identity owns this read; editor transitions invalidate it independently.
  useEffect(() => {
    if (!initialPresetId) {
      if (handledPreset.current) cancelOpening();
      handledPreset.current = null;
      return;
    }
    if (!library || handledPreset.current === initialPresetId) return;
    handledPreset.current = initialPresetId;
    const preset = library.promptPresets?.find((item) => item.id === initialPresetId);
    if (preset) void editPreset(preset, onInitialPresetHandled);
    else {
      cancelOpening();
      onError(descriptor('prompts.uiSelectedPromptNotFound'));
      onInitialPresetHandled?.();
    }
  }, [initialPresetId, library, onError, onInitialPresetHandled]);

  const [dirty, setDirty] = useState(false);
  const currentDirty = useRef(dirty);
  currentDirty.current = dirty;
  const [discard, setDiscard] = useState(false);
  const [savingNavigation, setSavingNavigation] = useState(false);
  const externalList = useRef(listRequest);
  const [moving, setMoving] = useState<LibraryItemKey[] | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const selectionExit = useRef<HTMLButtonElement>(null);
  const selectionStart = useRef<HTMLButtonElement>(null);
  const wasSelecting = useRef(false);
  const organizer = useLibraryOrganization(library, reload, onError);
  const mutation = useRef(false);
  const [mutating, setMutating] = useState(false);
  const [readingPreset, setReadingPreset] = useState(false);
  const busy = mutating || readingPreset;
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const createdPresetFocus = useRef<string | null>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const { workspace, refresh: refreshWorkspace } = usePromptWorkspace();
  const [applyingDefault, setApplyingDefault] = useState(false);
  const [defaultNotice, setDefaultNotice] = useState('');
  const organization = organizer.organization ?? library?.organization ?? null;
  const placements = libraryPlacements(organization);
  const folderOf = (id: string) =>
    placementOf(placements, { kind: 'prompt-preset', id })?.folderId ?? null;
  const presets = library?.promptPresets ?? [];
  const folders = sortedFolders(organization, 'prompts');
  const counts: Record<string, number> = {};
  for (const preset of presets) {
    const key = folderOf(preset.id);
    if (key !== null) counts[key] = (counts[key] ?? 0) + 1;
  }
  const searching = !!query.trim();
  const sectioned = folder === 'all' && !searching;
  const loweredQuery = query.toLocaleLowerCase();
  const ordered = sortLibraryItems(
    presets.filter(
      (item) =>
        (folder === 'all' || folderOf(item.id) === folder) &&
        (role === 'all' || item.role === role) &&
        item.title.toLocaleLowerCase().includes(loweredQuery)
    ),
    sort,
    manualOrder,
    locale
  );
  const collapsedFolders = useCollapsedFolders(organization);
  const isCollapsed = (folderId: string) => collapsedFolders.collapsed.includes(folderId);
  const sections = sectioned
    ? librarySections(ordered, folders, (item) => folderOf(item.id))
    : [{ folder: null, items: ordered }];
  const visible = sections
    .filter((section) => !section.folder || !isCollapsed(section.folder.id))
    .flatMap((section) => section.items);
  const visibleKey = visible.map((item) => item.id).join('\n');
  const listOf = (id: string) =>
    sections.find((section) => section.items.some((item) => item.id === id))?.items ?? [];
  const categoryEmpty = !!library && presets.length === 0 && !query;
  const folderEditor = useLibraryFolderEditor({
    category: 'prompts',
    organizer,
    reload,
    onError,
  });
  const itemDrag = useLibraryItemDrag({
    category: 'prompts',
    organizer,
    folderOf,
    manual: sort === 'manual',
    sectioned,
    disabled: selecting || busy,
    onReorder: moveManualItem,
  });
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    onEditingChange?.(!!editing);
  }, [editing, onEditingChange]);
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);
  useEffect(
    () => () => {
      opening.current?.abort();
      opening.current = null;
    },
    []
  );
  useEffect(() => {
    if (!editing?.preset || createdPresetFocus.current !== editing.preset.id) return;
    createdPresetFocus.current = null;
    const frame = requestAnimationFrame(() => editorHeading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editing]);
  useEffect(() => {
    if (selecting) selectionExit.current?.focus();
    else if (wasSelecting.current) selectionStart.current?.focus();
    wasSelecting.current = selecting;
  }, [selecting]);
  useEffect(() => {
    if (
      folder !== 'all' &&
      organizer.organization &&
      !organizer.organization.folders.some(
        (item) => item.id === folder && item.category === 'prompts'
      )
    )
      setFolder('all');
  }, [folder, organizer.organization]);
  useEffect(() => {
    const shown = new Set(visibleKey.split('\n'));
    setSelection((current) =>
      current.every((id) => shown.has(id)) ? current : current.filter((id) => shown.has(id))
    );
  }, [visibleKey]);
  useEffect(() => {
    const available = new Set(library?.promptPresets?.map((item) => item.id));
    setMoving((current) => (current?.some((item) => !available.has(item.id)) ? null : current));
  }, [library]);
  function changeSort(next: PromptSort) {
    setSort(next);
    saveLibrarySort('prompts', next);
  }
  function changeFolder(next: FolderFilter) {
    setFolder(next);
    setSelection([]);
  }
  function moveManualItem(id: string, beforeId: string | null) {
    const next = reorderManually(presets, manualOrder, locale, id, beforeId);
    setManualOrder(next);
    saveLibraryManualOrder('prompts', next);
  }
  function moveByOffset(id: string, offset: -1 | 1) {
    const beforeId = neighbourTarget(listOf(id), id, offset);
    if (beforeId !== undefined) moveManualItem(id, beforeId);
  }
  async function applyAsDefault(item: PromptPresetSummary) {
    if (!workspace || applyingDefault) return;
    setApplyingDefault(true);
    setDefaultNotice('');
    try {
      await callEndpoint(promptEndpoints.applyPreset, {
        expectedRevision: workspace.revision,
        role: item.role,
        presetId: item.id,
      });
      setDefaultNotice(descriptor('prompts.defaultChanged', { role: item.role, name: item.title }));
    } catch (error) {
      onError((error as Error).message);
      await refreshWorkspace().catch(() => {});
    } finally {
      setApplyingDefault(false);
    }
  }
  function cancelOpening() {
    if (!opening.current) return;
    opening.current.abort();
    opening.current = null;
    setReadingPreset(false);
  }
  async function editPreset(item: PromptPresetSummary, onHandled?: () => void) {
    cancelOpening();
    const controller = new AbortController();
    opening.current = controller;
    setReadingPreset(true);
    try {
      const preset = await api<PromptPreset>(
        `/prompt-presets/${encodeURIComponent(item.id)}`,
        undefined,
        'GET',
        controller.signal
      );
      if (opening.current !== controller) return;
      changeEditing({ preset, role: preset.role });
      onHandled?.();
    } catch (cause) {
      if (opening.current === controller) {
        onError((cause as Error).message);
        onHandled?.();
      }
    } finally {
      if (opening.current === controller) {
        opening.current = null;
        setReadingPreset(false);
      }
    }
  }
  function changeEditing(next: typeof editing) {
    cancelOpening();
    pendingEditing.current = next;
    if (currentDirty.current) setDiscard(true);
    else setEditing(next);
  }
  function close() {
    changeEditing(null);
  }
  function createPreset() {
    changeEditing({ preset: null, role: role === 'translation' ? role : 'main' });
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only an explicit request leaves the editor.
  useEffect(() => {
    if (externalList.current === listRequest) return;
    externalList.current = listRequest;
    cancelOpening();
    if (editing) close();
  }, [listRequest]);
  async function placeCreated(
    preset: PromptPreset,
    created: boolean,
    creationOrganizationRevision?: number | null
  ): Promise<boolean> {
    if (!created || folder === 'all') return true;
    if (creationOrganizationRevision === null) return false;
    const revision =
      creationOrganizationRevision ??
      (await callEndpoint(libraryEndpoints.readOrganization)).revision;
    const placed = await organizer.mutate(
      libraryEndpoints.moveItems,
      { items: [{ kind: 'prompt-preset', id: preset.id }], category: 'prompts', folderId: folder },
      revision
    );
    return !!placed;
  }
  async function clone(item: PromptPresetSummary) {
    if (mutation.current) return;
    mutation.current = true;
    setMutating(true);
    try {
      const result = await callEndpoint(resourceEditorEndpoints.cloneResource, {
        kind: 'prompt-preset',
        sourceId: item.id,
        expectedSourceRevision: item.revision,
        title: `${item.title.slice(0, 197).replace(/[\uD800-\uDBFF]$/u, '')}${t('shared.copySuffix')}`,
      });
      const copy = result.saved as PromptPreset;
      const warnings: string[] = [];
      try {
        if (!(await placeCreated(copy, true, result.creationOrganizationRevision ?? null)))
          warnings.push(descriptor('prompts.clonedPlacement', { error: '' }));
      } catch (error) {
        warnings.push(
          descriptor('prompts.clonedPlacement', { error: messageRef((error as Error).message) })
        );
      }
      try {
        await reload();
      } catch (error) {
        warnings.push(
          descriptor('prompts.clonedReload', {
            error: messageRef((error as Error).message),
          })
        );
      }
      if (warnings.length) onError(warnings.join('\n'));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      mutation.current = false;
      setMutating(false);
    }
  }
  async function addTemplate(id: string): Promise<PromptPreset | null> {
    if (mutation.current) return null;
    mutation.current = true;
    setMutating(true);
    try {
      const template = (await callEndpoint(promptEndpoints.readTemplate, { id })) as PromptTemplate;
      const created = await api<PromptPreset>('/prompt-presets', {
        title: template.title,
        role: template.role,
        program: template.program,
        values: template.values,
      });
      try {
        if (!(await placeCreated(created, true)))
          onError(descriptor('prompts.addedPlacement', { error: '' }));
      } catch (error) {
        onError(
          descriptor('prompts.addedPlacement', { error: messageRef((error as Error).message) })
        );
      }
      try {
        await reload();
      } catch (error) {
        onError(descriptor('prompts.addedReload', { error: messageRef((error as Error).message) }));
      }
      return created;
    } finally {
      mutation.current = false;
      setMutating(false);
    }
  }
  function renderItem(item: PromptPresetSummary) {
    const isDefault = workspace?.[item.role].presetId === item.id;
    const badgeId = `prompt-default-${item.id}`;
    return (
      <article
        className="library-list-item"
        key={item.id}
        data-library-item-id={item.id}
        data-selected={selecting && selection.includes(item.id) ? 'true' : undefined}
        {...itemDrag.item(item.id)}
      >
        {selecting && (
          <label className="library-select-check">
            <span className="sr-only">{t('prompts.selectNamed', { name: item.title })}</span>
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
          aria-describedby={isDefault ? badgeId : undefined}
          disabled={busy}
          onClick={() => void editPreset(item)}
        >
          <span className="library-prompt-icon" aria-hidden="true">
            <PromptIcon size={20} />
          </span>
          <span className="library-item-copy">
            <strong>{item.title}</strong>
            {isDefault ? (
              <span className="library-item-badges">
                <span id={badgeId} className="library-default-badge">
                  {item.role === 'main'
                    ? t('prompts.defaultWriting')
                    : t('prompts.defaultTranslation')}
                </span>
              </span>
            ) : (
              <span>
                {item.role === 'main' ? t('prompts.uiWriting') : t('prompts.uiTranslation')}
              </span>
            )}
          </span>
        </button>
        {!selecting && (
          <LibraryItemMenu title={t('prompts.menuNamed', { name: item.title })}>
            <div className="action-menu-group">
              {workspace && !isDefault && (
                <button
                  type="button"
                  className="secondary"
                  disabled={applyingDefault}
                  onClick={() => void applyAsDefault(item)}
                >
                  <CheckIcon size={18} aria-hidden="true" />
                  {t('prompts.useAsDefault')}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void editPreset(item)}
              >
                <EditIcon size={18} aria-hidden="true" />
                {t('prompts.uiEdit2')}
              </button>
              <button type="button" className="secondary" onClick={() => onAskHelper(item)}>
                <HelperIcon size={18} aria-hidden="true" />
                {t('prompts.uiAskHelper')}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void clone(item)}
              >
                <CopyIcon size={18} aria-hidden="true" />
                {t('prompts.uiDuplicate')}
              </button>
            </div>
            <div className="action-menu-group">
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
                    disabled={listOf(item.id)[0]?.id === item.id}
                    onClick={() => moveByOffset(item.id, -1)}
                  >
                    <UpIcon size={18} aria-hidden="true" />
                    {t('prompts.uiMoveUp')}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={listOf(item.id).at(-1)?.id === item.id}
                    onClick={() => moveByOffset(item.id, 1)}
                  >
                    <DownIcon size={18} aria-hidden="true" />
                    {t('prompts.uiMoveDown')}
                  </button>
                </>
              )}
            </div>
            <div className="action-menu-group">
              <DeleteButton
                endpoint={deletionEndpoints.deletePromptPreset}
                params={{ id: item.id }}
                revision={item.revision}
                title={item.title}
                onDeleted={reload}
                onError={onError}
              />
            </div>
          </LibraryItemMenu>
        )}
      </article>
    );
  }
  function renderItems(items: PromptPresetSummary[]) {
    return <div className="library-list">{items.map(renderItem)}</div>;
  }
  const selectedFolder = folders.find((item) => item.id === folder);
  const emptyState = !ordered.length && !(sectioned && folders.length && role === 'all') && (
    <div className="library-empty">
      <h2>
        {searching || role !== 'all'
          ? t('prompts.uiNoMatchingPrompts')
          : selectedFolder
            ? t('library.thisFolderIsEmpty')
            : t('prompts.uiNoPromptsYet')}
      </h2>
      <div className="library-empty-actions">
        {searching && (
          <button type="button" className="secondary" onClick={() => setQuery('')}>
            {t('prompts.clearSearch')}
          </button>
        )}
        {folder !== 'all' && (
          <button type="button" className="secondary" onClick={() => changeFolder('all')}>
            {t('prompts.uiSearchAll')}
          </button>
        )}
        {!searching && (
          <button type="button" onClick={createPreset}>
            <AddIcon size={20} aria-hidden="true" />
            {t('prompts.uiNewPrompt')}
          </button>
        )}
      </div>
    </div>
  );
  return (
    <section
      className={`library-page prompt-library${editing ? ' library-page-editing' : ''}`}
      aria-label={t('prompts.uiManagePrompts')}
      data-testid="prompt-library"
    >
      <header className="library-heading" hidden={!!editing}>
        {headerLeading}
        <h1>{t('prompts.uiPrompts')}</h1>
        {library && (
          <div className="library-heading-actions">
            <IconButton
              icon={SettingsIcon}
              size={18}
              className="secondary"
              label={t('prompts.defaultPromptSettings')}
              text={t('prompts.defaultPromptSettings')}
              onClick={onOpenCurrentPrompts}
            />
            <IconButton
              icon={TemplateIcon}
              size={18}
              className="secondary"
              label={t('prompts.templates')}
              text={t('prompts.templates')}
              disabled={busy || organizer.busy}
              onClick={() => setTemplatesOpen(true)}
            />
            <RisuPresetImport
              showTrigger
              reload={reload}
              onImported={(preset) => {
                createdPresetFocus.current = preset.id;
                changeEditing({ preset, role: preset.role });
              }}
            />
            <IconButton
              icon={AddIcon}
              size={18}
              className="primary"
              label={t('prompts.uiNewPrompt')}
              text={t('prompts.uiNewPrompt')}
              onClick={createPreset}
            />
          </div>
        )}
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
      {folderEditor.dialogs}
      <TransientNotice content={defaultNotice} />
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
              </>
            }
            headingRef={editorHeading}
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
        <>
          <ScrollStrip
            className="library-tabs"
            role="tablist"
            aria-label={t('prompts.uiFilterPromptRoles')}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const index = promptRoleTabs.findIndex((item) => item.id === role);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? promptRoleTabs.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + promptRoleTabs.length) %
                      promptRoleTabs.length;
              setRole(promptRoleTabs[next].id);
              (event.currentTarget.querySelectorAll('button')[next] as HTMLButtonElement).focus();
            }}
          >
            {promptRoleTabs.map((item) => (
              <button
                type="button"
                role="tab"
                id={`prompt-role-tab-${item.id}`}
                aria-controls="prompt-results"
                aria-selected={role === item.id}
                tabIndex={role === item.id ? 0 : -1}
                className="secondary"
                key={item.id}
                onClick={() => setRole(item.id)}
              >
                {t(item.titleKey)}
              </button>
            ))}
          </ScrollStrip>
          <div className="library-workspace">
            <div className="library-workspace-content">
              {(selecting || !categoryEmpty) && (
                <div className="library-toolbar">
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
                        onClick={() => setSelection(visible.map((item) => item.id))}
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
                        ref={selectionExit}
                        onClick={() => {
                          setSelecting(false);
                          setSelection([]);
                        }}
                      >
                        {t('prompts.uiDone')}
                      </button>
                    </div>
                  ) : (
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
                      <label className="library-sort-field">
                        <SortIcon size={18} aria-hidden="true" />
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
                      <IconButton
                        ref={selectionStart}
                        icon={SelectIcon}
                        size={18}
                        className="secondary"
                        label={t('prompts.uiSelect')}
                        onClick={() => {
                          setSelecting(true);
                          setSelection([]);
                        }}
                      />
                    </>
                  )}
                </div>
              )}
              {!selecting && (
                <LibraryFolderChips
                  category="prompts"
                  organizer={organizer}
                  value={folder}
                  onChange={changeFolder}
                  counts={counts}
                  total={presets.length}
                  editor={folderEditor}
                  itemDrag={itemDrag}
                />
              )}
              {searching && !selecting && (
                <p className="library-result-count muted" role="status">
                  {t('prompts.searchCount', { count: ordered.length })}
                </p>
              )}
              <div
                id="prompt-results"
                role="tabpanel"
                aria-labelledby={`prompt-role-tab-${role}`}
                className="library-results"
              >
                {selectedFolder ? (
                  <LibraryFolderSection
                    folder={selectedFolder}
                    title={selectedFolder.title}
                    count={counts[selectedFolder.id] ?? 0}
                    menu={
                      !selecting && (
                        <LibraryItemMenu
                          title={t('library.folderMenu', { v0: selectedFolder.title })}
                        >
                          {folderEditor.folderActions(selectedFolder)}
                        </LibraryItemMenu>
                      )
                    }
                  >
                    {ordered.length > 0 && renderItems(ordered)}
                    {emptyState}
                  </LibraryFolderSection>
                ) : sectioned && folders.length ? (
                  <>
                    {sections.map(({ folder: sectionFolder, items }) =>
                      sectionFolder ? (
                        (role === 'all' || items.length > 0) && (
                          <LibraryFolderSection
                            key={sectionFolder.id}
                            folder={sectionFolder}
                            title={sectionFolder.title}
                            count={items.length}
                            collapsed={isCollapsed(sectionFolder.id)}
                            onToggle={() => collapsedFolders.toggle(sectionFolder.id)}
                            menu={
                              !selecting && (
                                <LibraryItemMenu
                                  title={t('library.folderMenu', { v0: sectionFolder.title })}
                                >
                                  {folderEditor.folderActions(sectionFolder)}
                                </LibraryItemMenu>
                              )
                            }
                            drop={itemDrag.folder(sectionFolder.id)}
                          >
                            {items.length ? (
                              renderItems(items)
                            ) : (
                              <p className="library-section-empty muted">
                                {t('library.thisFolderIsEmpty')}
                              </p>
                            )}
                          </LibraryFolderSection>
                        )
                      ) : (
                        <LibraryFolderSection
                          key="unfiled"
                          folder={null}
                          title={t('library.uncategorizedRole', {
                            role: t('library.prompts'),
                          })}
                          count={items.length}
                          drop={itemDrag.folder(null)}
                        >
                          {renderItems(items)}
                        </LibraryFolderSection>
                      )
                    )}
                    {emptyState}
                  </>
                ) : (
                  <>
                    {ordered.length > 0 && renderItems(ordered)}
                    {emptyState}
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
