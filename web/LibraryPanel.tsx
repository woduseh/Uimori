import { ScrollStrip } from './ScrollStrip.js';
import { useShortcut } from './shortcuts.js';
import {
  t,
  useI18n,
  translateMessage,
  getLocale,
  message as descriptor,
  messageRef,
} from './i18n.js';
import { UiError, uiMessage } from './ui-message.js';
import { errorDescriptor } from './api-errors.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { DismissibleError } from './DismissibleError.js';
import { TransientNotice } from './TransientNotice.js';
import { SaveButton } from './SaveButton.js';
import { RisuNativeFields } from './RisuNativeFields.js';
import { useResourceAnchor } from './resource-anchor.js';
import { RisuExportButton } from './RisuExportButton.js';
import { IconButton } from './IconButton.js';
import { EditorStudio, useStudioSection } from './EditorStudio.js';
import { DraftDiscardActions } from './DraftDiscardActions.js';
import { SelectionCheckbox } from './BooleanControls.js';
import { RisuImport } from './RisuImport.js';
import {
  ResourceEditorProvider,
  ResourceEditorStatus,
  ResourceEditorActions,
  ResourceEditorLeaveWarning,
  requestResourceConflictReview,
  discardActiveEditor,
  saveActiveEditor,
  useEditorSaveCommand,
  useResourceEditor,
  useResourceEditorCommands,
} from './resource-editor.js';
import {
  availableSections,
  authoredContentModel,
  contentChangeSection,
  contentChanges,
  contentSectionRegistry,
  contentSections,
  defaultContentSection,
} from './studio-sections.js';
import { EditorChanges, PreviousVersionAction, RestoredVersionNotice } from './EditorChanges.js';
import { changedValuePaths } from './editor-values.js';
import { useCodeFieldBases } from './change-review.js';
import { CodeFieldBaseContext } from './CodeField.js';
import type { EditorReveal } from './code-field-reveal.js';
import { editableResource, type ContentEditModel } from '../core/resource-editing.js';
import { ResourceEditorSession } from './resource-editor-session.js';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Content, ContentKind, Library } from '../core/product.js';
import type { LibraryItemKey } from '../core/library-organization.js';
import { placementCategory } from '../core/library-organization.js';
import { deletionEndpoints, libraryEndpoints, resourceEditorEndpoints } from '#contracts';
import { api, callEndpoint } from './api.js';
import { refValue } from './content-ref.js';
import { nativeContentDraft, withNativeContentTitle } from './native-content-draft.js';
import { validateRisuContent } from '../core/risu-content.js';
import { DeleteButton } from './DeleteButton.js';
import { Dialog } from './Dialog.js';
import { ContentAvatar } from './ContentAvatar.js';
import { contentPortraitUrl } from './content-portrait.js';
import {
  AddIcon,
  BackIcon,
  BotIcon,
  CardsIcon,
  CopyIcon,
  EditIcon,
  HistoryIcon,
  ListIcon,
  ModuleIcon,
  MoveIcon,
  NewChatIcon,
  OptionsIcon,
  PersonaIcon,
  SearchIcon,
  SelectIcon,
  SortIcon,
  DownIcon,
  UpIcon,
} from './ui-icons.js';
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
  saveLibraryView,
  saveLibraryCardRatio,
  type LibrarySort,
} from './library-list-preferences.js';
import { readOptionalJson } from './optional-storage.js';
import { forgetBotStorage, storageKeys } from './storage-keys.js';

const contentLabelKeys: Record<ContentKind, string> = {
  bot: 'library.bot',
  persona: 'library.persona',
  module: 'library.module',
};
const freshContent = (kind: ContentKind): Omit<Content, 'id' | 'revision'> => ({
  kind,
  title: '',
  description: '',
  text: '',
  loading: 'pinned',
  relatedIds: [],
  package: nativeContentDraft(kind),
});
type EditorProps = {
  library: Library;
  reload: () => Promise<void>;
  onError: (error: string) => void;
};
type PrimaryLibraryTab = 'bot' | 'persona' | 'module';
const libraryTabs: { id: PrimaryLibraryTab; titleKey: string; icon: typeof BotIcon }[] = [
  {
    id: 'bot',
    titleKey: 'library.bot',
    icon: BotIcon,
  },
  {
    id: 'persona',
    titleKey: 'library.persona',
    icon: PersonaIcon,
  },
  {
    id: 'module',
    titleKey: 'library.module',
    icon: ModuleIcon,
  },
];
type ViewMode = 'cards' | 'list';
type SortMode = LibrarySort;
type CardRatio = '1:1' | '2:3' | '3:4' | '9:16';
const cardRatios: CardRatio[] = ['1:1', '2:3', '3:4', '9:16'];
function storedByTab(key: string) {
  return (readOptionalJson('local', key, null) ?? {}) as Record<string, unknown>;
}
function savedViews(): Record<PrimaryLibraryTab, ViewMode> {
  const defaults: Record<PrimaryLibraryTab, ViewMode> = {
    bot: 'cards',
    persona: 'cards',
    module: 'list',
  };
  const stored = storedByTab(storageKeys.libraryViews);
  for (const { id } of libraryTabs)
    if (stored[id] === 'cards' || stored[id] === 'list') defaults[id] = stored[id];
  return defaults;
}
function savedCardRatios(): Record<PrimaryLibraryTab, CardRatio> {
  const defaults: Record<PrimaryLibraryTab, CardRatio> = {
    bot: '1:1',
    persona: '1:1',
    module: '1:1',
  };
  const stored = storedByTab(storageKeys.libraryCardRatios);
  for (const { id } of libraryTabs)
    if (cardRatios.includes(stored[id] as CardRatio)) defaults[id] = stored[id] as CardRatio;
  return defaults;
}
function savedSorts(): Record<PrimaryLibraryTab, SortMode> {
  const defaults: Record<PrimaryLibraryTab, SortMode> = {
    bot: 'name',
    persona: 'name',
    module: 'name',
  };
  const stored = storedByTab(storageKeys.librarySorts);
  for (const { id } of libraryTabs)
    if (stored[id] === 'name' || stored[id] === 'name-desc' || stored[id] === 'manual')
      defaults[id] = stored[id];
  return defaults;
}
function savedManualOrders(): Record<PrimaryLibraryTab, string[]> {
  const defaults: Record<PrimaryLibraryTab, string[]> = { bot: [], persona: [], module: [] };
  const stored = storedByTab(storageKeys.libraryManualOrders);
  for (const { id } of libraryTabs)
    if (Array.isArray(stored[id]))
      defaults[id] = stored[id].filter((value): value is string => typeof value === 'string');
  return defaults;
}
export function LibraryPanel({
  library,
  reload,
  libraryError = '',
  onError,
  onStartStory,
  onConfigureStartStory,
  onUseContent,
  initialTab = 'bot',
  listRequest = 0,
  initialContentId,
  onInitialContentHandled,
  onTabChange,
  onDirtyChange,
  onEditingChange,
  recentChatByContent,
  onContinueChat,
  headerLeading,
  headerTrailing,
}: {
  library: Library | null;
  reload: () => Promise<void>;
  libraryError?: string;
  onError: (error: string) => void;
  onStartStory?: (bot: Content) => void;
  onConfigureStartStory?: (bot: Content) => void;
  onUseContent?: (content: Content, role: PrimaryLibraryTab) => void;
  initialTab?: PrimaryLibraryTab;
  listRequest?: number;
  initialContentId?: string | null;
  onInitialContentHandled?: (id: string) => void;
  onTabChange?: (tab: PrimaryLibraryTab) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onEditingChange?: (editing: boolean) => void;
  recentChatByContent?: Record<string, string>;
  onContinueChat?: (chatId: string) => void;
  headerLeading?: ReactNode;
  headerTrailing?: ReactNode;
}) {
  useI18n();
  const [tab, setTab] = useState(initialTab);
  const [dirty, setDirty] = useState(false);
  const [savingNavigation, setSavingNavigation] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{
    tab: PrimaryLibraryTab;
    closeOnly?: boolean;
  } | null>(null);
  const [query, setQuery] = useState('');
  const [sortByTab, setSortByTab] = useState(savedSorts);
  const [manualOrderByTab, setManualOrderByTab] = useState(savedManualOrders);
  const [views, setViews] = useState(savedViews);
  const [cardRatioByTab, setCardRatioByTab] = useState(savedCardRatios);
  const [folder, setFolder] = useState<FolderFilter>('all');
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moving, setMoving] = useState<LibraryItemKey[] | null>(null);
  const [editing, setEditing] = useState<{ kind: ContentKind; item: Content | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const selectionExit = useRef<HTMLButtonElement>(null);
  const wasSelecting = useRef(false);
  const opening = useRef(0);
  const cloning = useRef(false);
  const latestLibrary = useRef(library);
  latestLibrary.current = library;
  const externalTab = useRef(initialTab);
  const organizer = useLibraryOrganization(library, reload, onError);
  const organization = organizer.organization ?? library?.organization ?? null;
  const placements = libraryPlacements(organization);
  const folderOf = (id: string) =>
    placementOf(placements, { kind: 'content', id })?.folderId ?? null;
  const categoryOf = (item: Content): PrimaryLibraryTab =>
    placementCategory(placementOf(placements, { kind: 'content', id: item.id }), item);
  const categoryItems = library?.contents.filter((item) => categoryOf(item) === tab) ?? [];
  const folders = sortedFolders(organization, tab);
  const counts: Record<string, number> = {};
  const folderCovers: Record<string, string[]> = {};
  for (const item of categoryItems) {
    const key = folderOf(item.id);
    if (key === null) continue;
    counts[key] = (counts[key] ?? 0) + 1;
    const portrait = contentPortraitUrl(item);
    const cover = (folderCovers[key] ??= []);
    if (portrait && cover.length < 24 && !cover.includes(portrait)) cover.push(portrait);
  }
  const sort = sortByTab[tab];
  const manualOrder = manualOrderByTab[tab];
  const searching = !!query.trim();
  const sectioned = folder === 'all' && !searching;
  const loweredQuery = query.toLocaleLowerCase();
  const ordered = sortLibraryItems(
    categoryItems.filter(
      (item) =>
        (folder === 'all' || folderOf(item.id) === folder) &&
        `${item.title} ${item.description}`.toLocaleLowerCase().includes(loweredQuery)
    ),
    sort,
    manualOrder,
    getLocale()
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
  const folderEditor = useLibraryFolderEditor({
    category: tab,
    organizer,
    reload,
    onError,
    covers: folderCovers,
  });
  const itemDrag = useLibraryItemDrag({
    category: tab,
    organizer,
    folderOf,
    manual: sort === 'manual',
    sectioned,
    disabled: selecting,
    onReorder: moveManualItem,
  });
  useLayoutEffect(() => {
    if (editing)
      panelRef.current?.closest<HTMLElement>('.destination-scroll')?.scrollTo({ top: 0 });
  }, [editing]);
  useEffect(() => {
    if (selecting) selectionExit.current?.focus();
    else if (wasSelecting.current)
      panelRef.current?.querySelector<HTMLElement>('.library-list-options > summary')?.focus();
    wasSelecting.current = selecting;
  }, [selecting]);
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
      opening.current++;
    },
    []
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: External tab requests must not rerun on local draft updates.
  useEffect(() => {
    if (externalTab.current !== initialTab) {
      externalTab.current = initialTab;
      navigate(initialTab);
    }
  }, [initialTab]);
  const externalList = useRef(listRequest);
  const handledContent = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit identity owns the read, not editor renders
  useEffect(() => {
    if (!initialContentId) {
      handledContent.current = null;
      return;
    }
    if (!library || handledContent.current === initialContentId) return;
    handledContent.current = initialContentId;
    const item = library.contents.find((value) => value.id === initialContentId);
    if (item) {
      setTab(item.kind === 'persona' || item.kind === 'module' ? item.kind : 'bot');
      void openContent(item).finally(() => onInitialContentHandled?.(initialContentId));
    } else onInitialContentHandled?.(initialContentId);
  }, [initialContentId, library, onInitialContentHandled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only an explicit request leaves the editor.
  useEffect(() => {
    if (externalList.current === listRequest) return;
    externalList.current = listRequest;
    navigate(initialTab);
  }, [listRequest]);
  useEffect(() => {
    if (
      folder !== 'all' &&
      organizer.organization &&
      !organizer.organization.folders.some((item) => item.id === folder && item.category === tab)
    )
      setFolder('all');
  }, [folder, organizer.organization, tab]);
  useEffect(() => {
    const shown = new Set(visibleKey.split('\n'));
    setSelectedIds((current) =>
      current.every((id) => shown.has(id)) ? current : current.filter((id) => shown.has(id))
    );
  }, [visibleKey]);
  useEffect(() => {
    if (!library) {
      setMoving(null);
      return;
    }
    const available = new Set(library.contents.map((item) => item.id));
    setMoving((current) => (current?.some((item) => !available.has(item.id)) ? null : current));
  }, [library]);
  function cancelOpening() {
    opening.current++;
    setLoading(false);
  }
  function switchTab(next: PrimaryLibraryTab, closeOnly = false) {
    cancelOpening();
    setEditing(null);
    setDirty(false);
    setMoving(null);
    setSelectedIds([]);
    setSelecting(false);
    if (!closeOnly) {
      setTab(next);
      setFolder('all');
      setQuery('');
      externalTab.current = next;
      onTabChange?.(next);
    }
  }
  function navigate(next: PrimaryLibraryTab, closeOnly = false) {
    if (next === tab && !closeOnly && !editing) return;
    if (dirty) setPendingNavigation({ tab: next, closeOnly });
    else switchTab(next, closeOnly);
  }
  function continueEditing() {
    setPendingNavigation(null);
    externalTab.current = tab;
    onTabChange?.(tab);
  }
  async function placeCreated(
    item: Content,
    cloned = false,
    creationOrganizationRevision?: number | null
  ) {
    const folderId = folder === 'all' ? null : folder;
    if ((!cloned && item.kind !== tab) || (folderId === null && item.kind === tab)) return;
    if (creationOrganizationRevision === null)
      throw new UiError(uiMessage('library.couldNotCompleteFolderPlacement'));
    const revision =
      creationOrganizationRevision ??
      (await callEndpoint(libraryEndpoints.readOrganization)).revision;
    const placed = await organizer.mutate(
      libraryEndpoints.moveItems,
      { items: [{ kind: 'content', id: item.id }], category: tab, folderId },
      revision
    );
    if (!placed) throw new UiError(uiMessage('library.couldNotCompleteFolderPlacement'));
  }
  async function openContent(
    item: Content,
    action: 'edit' | 'clone' | 'configure-chat' | PrimaryLibraryTab = 'edit'
  ) {
    if (action === 'clone') {
      if (cloning.current) return;
      cloning.current = true;
    }
    const request = ++opening.current;
    setLoading(true);
    try {
      const full =
        action !== 'clone' && (library?.contentBodiesOmitted || (item.hasPackage && !item.package))
          ? await api<Content>(`/content/${item.id}`)
          : item;
      if (
        request !== opening.current ||
        !latestLibrary.current?.contents.some((current) => current.id === item.id)
      )
        return;
      if (action === 'edit') {
        setEditing({ kind: full.kind, item: full });
      } else if (action === 'clone') {
        const result = await callEndpoint(resourceEditorEndpoints.cloneResource, {
          kind: 'content',
          sourceId: full.id,
          expectedSourceRevision: full.revision,
          title: `${full.title.slice(0, 197).replace(/[\uD800-\uDBFF]$/u, '')}${t('shared.copySuffix')}`,
        });
        const copy = result.saved as Content;
        const warnings: string[] = [];
        try {
          await placeCreated(copy, true, result.creationOrganizationRevision ?? null);
        } catch (error) {
          warnings.push(
            descriptor('library.theResourceWasCopiedButCouldNot', {
              v0: messageRef((error as Error).message),
            })
          );
        }
        try {
          await reload();
        } catch (error) {
          warnings.push(
            descriptor('library.theResourceWasCopiedButTheList', {
              v0: messageRef((error as Error).message),
            })
          );
        }
        if (request === opening.current) {
          setEditing({ kind: copy.kind, item: copy });
          if (warnings.length)
            onError(
              warnings.length === 1
                ? warnings[0]
                : descriptor('library.cloneWarnings', {
                    first: messageRef(warnings[0]),
                    second: messageRef(warnings[1]),
                  })
            );
        }
      } else if (action === 'configure-chat') onConfigureStartStory?.(full);
      else applyRole(full, action);
    } catch (error) {
      if (request === opening.current) onError(errorDescriptor(error));
    } finally {
      if (action === 'clone') cloning.current = false;
      if (request === opening.current) setLoading(false);
    }
  }
  function applyRole(item: Content, role: PrimaryLibraryTab) {
    if (onUseContent) onUseContent(item, role);
    else if (role === 'bot') onStartStory?.(item);
  }
  const canUse = (role: PrimaryLibraryTab) =>
    role === 'bot' ? !!(onUseContent || onStartStory) : !!onUseContent;
  function openNew() {
    cancelOpening();
    setEditing({ kind: tab, item: null });
  }
  function changeFolder(next: FolderFilter) {
    setFolder(next);
    setQuery('');
    setSelectedIds([]);
  }
  function toggleSelection(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id]
    );
  }
  const categoryEmpty = !!library && categoryItems.length === 0 && !query;
  function setView(mode: ViewMode) {
    const next = { ...views, [tab]: mode };
    setViews(next);
    saveLibraryView(tab, mode);
  }
  function setSort(mode: SortMode) {
    const next = { ...sortByTab, [tab]: mode };
    setSortByTab(next);
    saveLibrarySort(tab, mode);
  }
  function moveManualItem(id: string, beforeId: string | null) {
    const next = reorderManually(categoryItems, manualOrder, getLocale(), id, beforeId);
    setManualOrderByTab({ ...manualOrderByTab, [tab]: next });
    saveLibraryManualOrder(tab, next);
  }
  function moveManualByOffset(item: Content, offset: -1 | 1) {
    const beforeId = neighbourTarget(listOf(item.id), item.id, offset);
    if (beforeId !== undefined) moveManualItem(item.id, beforeId);
  }
  function setCardRatio(ratio: CardRatio) {
    const next = { ...cardRatioByTab, [tab]: ratio };
    setCardRatioByTab(next);
    saveLibraryCardRatio(tab, ratio);
  }
  function itemMenu(item: Content) {
    const list = listOf(item.id);
    return (
      <LibraryItemMenu title={t('library.menu', { v0: item.title })}>
        <div className="action-menu-group">
          {tab === 'bot' && onConfigureStartStory && (
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => void openContent(item, 'configure-chat')}
            >
              <NewChatIcon size={18} aria-hidden="true" />
              {t('transfer.configureNewChat')}
            </button>
          )}
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => void openContent(item, 'edit')}
          >
            <EditIcon size={18} aria-hidden="true" />
            {t('library.edit')}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => void openContent(item, 'clone')}
          >
            <CopyIcon size={18} aria-hidden="true" />
            {t('library.duplicate')}
          </button>
        </div>
        <div className="action-menu-group">
          <button
            type="button"
            className="secondary"
            disabled={organizer.busy}
            onClick={() => setMoving([{ kind: 'content', id: item.id }])}
          >
            <MoveIcon size={18} aria-hidden="true" />
            {t('library.moveCategoryOrFolder')}
          </button>
          {sort === 'manual' && (
            <>
              <button
                type="button"
                className="secondary"
                disabled={list[0]?.id === item.id}
                onClick={() => moveManualByOffset(item, -1)}
              >
                <UpIcon size={18} aria-hidden="true" />
                {t('library.moveUp')}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={list.at(-1)?.id === item.id}
                onClick={() => moveManualByOffset(item, 1)}
              >
                <DownIcon size={18} aria-hidden="true" />
                {t('library.moveDown')}
              </button>
            </>
          )}
        </div>
        <div className="action-menu-group">
          <DeleteButton
            endpoint={deletionEndpoints.deleteContent}
            params={{ id: item.id }}
            revision={item.revision}
            title={item.title}
            onDeleted={async () => {
              forgetBotStorage(item.id);
              cancelOpening();
              await reload();
            }}
            onError={onError}
          />
        </div>
      </LibraryItemMenu>
    );
  }
  function renderItem(item: Content) {
    return (
      <article
        className={
          views[tab] === 'cards' ? 'library-card library-portrait-card' : 'library-list-item'
        }
        key={item.id}
        data-library-item-id={item.id}
        data-has-portrait={item.kind === 'module' ? undefined : !!contentPortraitUrl(item)}
        data-selected={selecting && selectedIds.includes(item.id) ? 'true' : undefined}
        data-selecting={selecting ? 'true' : undefined}
        {...itemDrag.item(item.id)}
      >
        {selecting && (
          <label className="library-select-check">
            <span className="sr-only">{t('library.select2', { v0: item.title })}</span>
            <SelectionCheckbox
              aria-label={t('library.select2', { v0: item.title })}
              checked={selectedIds.includes(item.id)}
              onChange={(event) =>
                setSelectedIds((current) =>
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
          aria-label={t('library.detailAction', {
            title: item.title,
            action: selecting ? 'select' : 'edit',
          })}
          aria-pressed={selecting ? selectedIds.includes(item.id) : undefined}
          onClick={() => (selecting ? toggleSelection(item.id) : void openContent(item))}
          disabled={loading}
        >
          <ContentAvatar content={item} className="library-item-avatar" />
          <span className="library-item-copy">
            <strong title={item.title}>{item.title}</strong>
            {item.description && <span>{item.description}</span>}
            {searching && folder === 'all' && (
              <small className="library-result-folder">
                {folders.find((entry) => entry.id === folderOf(item.id))?.title ??
                  t('library.uncategorized')}
              </small>
            )}
          </span>
        </button>
        {!selecting && tab === 'bot' && (onUseContent || onStartStory) && (
          <button
            type="button"
            className="secondary library-start-chat"
            disabled={loading}
            aria-label={t('library.newChatWith', { v0: item.title })}
            onClick={() => void openContent(item, 'bot')}
          >
            <NewChatIcon size={20} aria-hidden="true" />
            <span>{t('library.newChat')}</span>
          </button>
        )}
        {!selecting && itemMenu(item)}
      </article>
    );
  }
  function renderItems(items: Content[]) {
    return (
      <div
        className={views[tab] === 'cards' ? 'library-cards library-portrait-cards' : 'library-list'}
        data-card-ratio={views[tab] === 'cards' ? cardRatioByTab[tab] : undefined}
      >
        {items.map(renderItem)}
      </div>
    );
  }
  const selectedFolder = folders.find((item) => item.id === folder);
  const emptyHeading = searching
    ? t('library.noMatchingResources')
    : selectedFolder
      ? t('library.thisFolderIsEmpty')
      : !folders.length && !categoryItems.length
        ? t('library.noRegisteredResourcesYet')
        : '';
  const emptyState = !ordered.length && !!emptyHeading && (
    <div className="library-empty">
      <h2>{emptyHeading}</h2>
      <div className="library-empty-actions">
        {query && (
          <button type="button" className="secondary" onClick={() => setQuery('')}>
            {t('library.clearSearch')}
          </button>
        )}
        {folder !== 'all' && (
          <button type="button" className="secondary" onClick={() => changeFolder('all')}>
            {t('library.showAll')}
          </button>
        )}
        {!query && (
          <button type="button" onClick={openNew}>
            <AddIcon size={20} aria-hidden="true" />
            {t('library.create', { v0: t(contentLabelKeys[tab]) })}
          </button>
        )}
      </div>
    </div>
  );
  const newLabel = t('library.new', { v0: t(contentLabelKeys[tab]) });
  return (
    <section
      ref={panelRef}
      className={`library-page${editing ? ' library-page-editing' : ''}${!library ? ' library-page-loading' : ''}`}
      data-testid="library-panel"
      aria-label={t('library.library')}
    >
      <header className="library-heading" hidden={!!editing}>
        {headerLeading}
        <h1>{t('library.library')}</h1>
        {library && (
          <div className="library-heading-actions">
            <RisuImport
              defaultKind={tab === 'bot' ? '' : tab}
              reload={reload}
              onContinueChat={onContinueChat}
            />
            <IconButton
              className="primary"
              icon={AddIcon}
              size={18}
              label={newLabel}
              text={newLabel}
              onClick={openNew}
            />
          </div>
        )}
        {headerTrailing}
      </header>
      <Dialog
        open={!!pendingNavigation}
        title={t('library.reviewUnsavedResource')}
        variant="confirmation"
        role="alertdialog"
        onClose={() => {
          if (!savingNavigation) continueEditing();
        }}
      >
        <p>{t('library.leavingWillDiscardUnsavedEdits')}</p>
        <ResourceEditorLeaveWarning />
        <DraftDiscardActions
          open={!!pendingNavigation}
          onSavingChange={setSavingNavigation}
          onContinue={continueEditing}
          onSave={async () => {
            const destination = pendingNavigation;
            if (!destination || !(await saveActiveEditor())) return false;
            switchTab(destination.tab, destination.closeOnly);
            setPendingNavigation(null);
            return true;
          }}
          onDiscard={async () => {
            if (!pendingNavigation) return;
            try {
              await discardActiveEditor();
              switchTab(pendingNavigation.tab, pendingNavigation.closeOnly);
              setPendingNavigation(null);
            } catch (error) {
              onError(errorDescriptor(error));
            }
          }}
          discardLabel={t('library.discardDraftAndLeave')}
        />
      </Dialog>
      <LibraryMoveDialog
        items={moving}
        category={tab}
        organizer={organizer}
        onClose={() => setMoving(null)}
        onMoved={() => {
          setMoving(null);
          setSelectedIds([]);
          setSelecting(false);
        }}
      />
      {folderEditor.dialogs}
      {loading && (
        <LoadingState presentation="inline" label={t('library.loadingResourceContent')} />
      )}
      {!library ? (
        <LoadingState
          presentation="region"
          loading={!libraryError}
          error={libraryError}
          label={t('library.loadingLibrary')}
          errorLabel={t('library.couldNotLoadTheLibrary')}
          onRetry={() => void reload().catch(() => {})}
        />
      ) : editing ? (
        <ContentEditor
          key={editing.item ? refValue(editing.item) : `new-${editing.kind}`}
          library={library}
          reload={reload}
          onError={onError}
          initial={editing.item}
          kind={editing.kind}
          onClose={() => navigate(tab, true)}
          onDeleted={() => switchTab(tab, true)}
          onDirtyChange={setDirty}
          placement={(item) => {
            const folderId = item ? folderOf(item.id) : null;
            return {
              category: item ? categoryOf(item) : editing.kind,
              folder: folderId
                ? organization?.folders.find((entry) => entry.id === folderId)?.title
                : undefined,
            };
          }}
          canUse={canUse}
          onUse={applyRole}
          onConfigureChat={onConfigureStartStory}
          recentChats={recentChatByContent}
          onContinueChat={onContinueChat}
          onDuplicate={(item) => void openContent(item, 'clone')}
          onMove={(item) => setMoving([{ kind: 'content', id: item.id }])}
          moving={organizer.busy || loading}
          onCreated={(item, revision) => placeCreated(item, false, revision)}
          headerLeading={headerLeading}
          headerTrailing={headerTrailing}
        />
      ) : (
        <>
          <ScrollStrip
            className="library-tabs"
            role="tablist"
            aria-label={t('library.libraryCategories')}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const index = libraryTabs.findIndex((item) => item.id === tab);
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? libraryTabs.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + libraryTabs.length) %
                      libraryTabs.length;
              navigate(libraryTabs[next].id);
              (event.currentTarget.querySelectorAll('button')[next] as HTMLButtonElement).focus();
            }}
          >
            {libraryTabs.map((item) => (
              <button
                type="button"
                role="tab"
                id={`library-tab-${item.id}`}
                aria-controls="library-results"
                aria-selected={tab === item.id}
                tabIndex={tab === item.id ? 0 : -1}
                className="secondary"
                key={item.id}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={18} aria-hidden="true" />
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
                      aria-label={t('library.resourceSelectionActions')}
                    >
                      <span role="status">
                        {t('library.selectedCount', { count: selectedIds.length })}
                      </span>
                      <button
                        type="button"
                        className="secondary"
                        aria-label={t('library.selectAllVisibleResources')}
                        onClick={() => setSelectedIds(visible.map((item) => item.id))}
                      >
                        <SelectIcon size={18} aria-hidden="true" />
                        <span>{t('library.selectAll')}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={t('library.moveSelectedResources')}
                        disabled={!selectedIds.length || organizer.busy}
                        onClick={() =>
                          setMoving(selectedIds.map((id) => ({ kind: 'content', id })))
                        }
                      >
                        <MoveIcon size={18} aria-hidden="true" />
                        <span>{t('library.move')}</span>
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        ref={selectionExit}
                        onClick={() => {
                          setSelectedIds([]);
                          setSelecting(false);
                        }}
                      >
                        {t('library.done')}
                      </button>
                    </div>
                  ) : (
                    <>
                      <label className="library-search-field">
                        <SearchIcon size={20} aria-hidden="true" />
                        <span className="sr-only">{t('library.searchLibrary')}</span>
                        <input
                          type="search"
                          aria-label={t('library.searchLibrary')}
                          placeholder={t('library.searchByNameOrDescription')}
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                        />
                      </label>
                      <label className="library-sort-field">
                        <SortIcon size={18} aria-hidden="true" />
                        <select
                          aria-label={t('library.resourceSortOrder')}
                          value={sort}
                          onChange={(event) => setSort(event.target.value as SortMode)}
                        >
                          <option value="name">{t('library.nameAscending')}</option>
                          <option value="name-desc">{t('library.nameDescending')}</option>
                          <option value="manual">{t('library.manualOrder')}</option>
                        </select>
                      </label>
                      <div
                        className="library-view-buttons"
                        role="group"
                        aria-label={t('library.resourceView')}
                      >
                        <IconButton
                          icon={CardsIcon}
                          size={18}
                          label={t('library.cards')}
                          title={t('library.cardView')}
                          className="secondary"
                          aria-pressed={views[tab] === 'cards'}
                          onClick={() => setView('cards')}
                        />
                        <IconButton
                          icon={ListIcon}
                          size={18}
                          label={t('library.list')}
                          title={t('library.listView')}
                          className="secondary"
                          aria-pressed={views[tab] === 'list'}
                          onClick={() => setView('list')}
                        />
                      </div>
                      <LibraryItemMenu
                        title={t('library.manageList')}
                        className="library-list-options"
                        icon={OptionsIcon}
                      >
                        <div className="library-list-options-body">
                          {views[tab] === 'cards' && (
                            <div className="library-card-ratio">
                              <span>{t('library.cardAspectRatio')}</span>
                              <div
                                className="library-ratio-buttons"
                                role="group"
                                aria-label={t('library.cardAspectRatio')}
                              >
                                {cardRatios.map((ratio) => (
                                  <button
                                    type="button"
                                    className="secondary"
                                    key={ratio}
                                    aria-label={t('library.cardAspectRatio2', { v0: ratio })}
                                    aria-pressed={cardRatioByTab[tab] === ratio}
                                    onClick={() => setCardRatio(ratio)}
                                  >
                                    {ratio}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => {
                              setSelecting(true);
                              setSelectedIds([]);
                            }}
                          >
                            <SelectIcon size={18} aria-hidden="true" />
                            {t('library.select')}
                          </button>
                        </div>
                      </LibraryItemMenu>
                    </>
                  )}
                </div>
              )}
              {!selecting && (
                <LibraryFolderChips
                  category={tab}
                  organizer={organizer}
                  value={folder}
                  onChange={changeFolder}
                  counts={counts}
                  total={categoryItems.length}
                  editor={folderEditor}
                  itemDrag={itemDrag}
                />
              )}
              {searching && !selecting && (
                <p className="library-result-count muted" role="status">
                  {t('library.resultCount', { count: ordered.length })}
                </p>
              )}
              <div
                id="library-results"
                role="tabpanel"
                aria-labelledby={`library-tab-${tab}`}
                className="library-results"
              >
                {selectedFolder ? (
                  <LibraryFolderSection
                    folder={selectedFolder}
                    title={selectedFolder.title}
                    count={counts[selectedFolder.id] ?? 0}
                    covers={folderCovers[selectedFolder.id]}
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
                  sections.map(({ folder: sectionFolder, items }) =>
                    sectionFolder ? (
                      <LibraryFolderSection
                        key={sectionFolder.id}
                        folder={sectionFolder}
                        title={sectionFolder.title}
                        count={items.length}
                        covers={folderCovers[sectionFolder.id]}
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
                    ) : (
                      <LibraryFolderSection
                        key="unfiled"
                        folder={null}
                        title={t('library.uncategorizedRole', {
                          role: t(contentLabelKeys[tab]),
                        })}
                        count={items.length}
                        drop={itemDrag.folder(null)}
                      >
                        {renderItems(items)}
                      </LibraryFolderSection>
                    )
                  )
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
function roleActionLabel(role: PrimaryLibraryTab) {
  return role === 'bot'
    ? t('library.newChatAsBot')
    : role === 'persona'
      ? t('library.useAsPersona')
      : t('library.addAs', { v0: t(contentLabelKeys[role]) });
}
function RoleActionIcon({ role }: { role: PrimaryLibraryTab }) {
  const Icon = role === 'bot' ? NewChatIcon : role === 'persona' ? PersonaIcon : ModuleIcon;
  return <Icon size={18} aria-hidden="true" />;
}
function ContentOverviewMeta({
  category,
  folder,
  counts,
}: {
  category: PrimaryLibraryTab | null;
  folder?: string;
  counts: readonly { id: string; title: string; count?: number }[];
}) {
  return (
    <>
      {category && (
        <p className="native-identity-meta ui-meta-row">
          <span>{t(contentLabelKeys[category])}</span>
          {folder && <span>{folder}</span>}
        </p>
      )}
      {counts.length > 0 && (
        <p className="native-identity-meta ui-meta-row">
          {counts.map((item) => (
            <span key={item.id}>
              {t('library.labelCount', { label: item.title, count: item.count! })}
            </span>
          ))}
        </p>
      )}
    </>
  );
}
function ContentEditor({
  reload,
  onError,
  initial,
  kind,
  onClose,
  onDeleted,
  onDirtyChange,
  placement,
  canUse,
  onUse,
  onConfigureChat,
  recentChats,
  onContinueChat,
  onDuplicate,
  onMove,
  moving,
  onCreated,
  headerLeading,
  headerTrailing,
}: EditorProps & {
  initial: Content | null;
  kind: ContentKind;
  onClose: () => void;
  onDeleted: () => void;
  onDirtyChange: (dirty: boolean) => void;
  placement: (content: Content | null) => { category: PrimaryLibraryTab; folder?: string };
  canUse: (role: PrimaryLibraryTab) => boolean;
  onUse: (content: Content, role: PrimaryLibraryTab) => void;
  onConfigureChat?: (bot: Content) => void;
  recentChats?: Record<string, string>;
  onContinueChat?: (chatId: string) => void;
  onDuplicate: (content: Content) => void;
  onMove: (content: Content) => void;
  moving: boolean;
  onCreated?: (content: Content, creationOrganizationRevision: number | null) => Promise<void>;
  headerLeading?: ReactNode;
  headerTrailing?: ReactNode;
}) {
  useI18n();
  const formId = useId();
  const [session] = useState(
    () =>
      new ResourceEditorSession({
        editorKey: initial ? `content:${initial.id}` : `new:content:${kind}`,
        kind: 'content',
        targetId: initial?.id ?? null,
        initialModel: initial ? editableResource('content', initial) : freshContent(kind),
      })
  );
  const shared = useResourceEditor<ContentEditModel>(session);
  const { model: value, setModel: setValue, state } = shared;
  const { document, dirty } = state;
  const commands = useResourceEditorCommands(shared);
  const sectionId = useId();
  const [section, selectSection] = useStudioSection(
    `content:${value.kind}`,
    availableSections(contentSectionRegistry, value.package),
    defaultContentSection(value.package, value.kind),
    !!initial
  );
  const sections = contentSections(value.package, value.kind, section, state.local.unappliedFields);
  const changedPaths = useMemo(
    () => (dirty ? changedValuePaths(document.baseModel, value) : []),
    [dirty, document.baseModel, value]
  );
  const changes = dirty
    ? contentChanges(sections, changedPaths, [
        ...Object.keys(state.local.rawFields),
        ...state.local.unappliedFields,
      ])
    : [];
  const sectionOf = contentChangeSection(sections);
  const codeBases = useCodeFieldBases(document.baseModel, value, dirty, sectionOf);
  const [reveal, setReveal] = useState<EditorReveal | null>(null);
  const revealEpoch = useRef(0);
  const anchor = useResourceAnchor('content', document.targetId);
  const selected = document.targetId
    ? {
        ...(document.baseModel as ContentEditModel),
        id: document.targetId,
        revision: document.baseRevision!,
      }
    : null;
  const { category, folder } = placement(selected);
  const recentChat = selected ? recentChats?.[selected.id] : undefined;
  const [placing, setPlacing] = useState(false);
  const busy = state.saving || placing;
  const [saved, setSaved] = useState('');
  const [saveWarnings, setSaveWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [exportError, setExportError] = useState('');
  const nativeDraftDirty = state.local.unappliedFields.length > 0;
  const [portraitBusy, setPortraitBusy] = useState(false);
  const saveVersion = useRef(0);
  useEffect(
    () => () => {
      saveVersion.current++;
    },
    []
  );
  const editorUnavailable = busy || !state.ready;
  const savedVersionBusy = editorUnavailable || dirty || nativeDraftDirty || portraitBusy;
  useEffect(() => {
    onDirtyChange(dirty || busy || portraitBusy || state.creationPending);
  }, [dirty, busy, portraitBusy, state.creationPending, onDirtyChange]);
  const packageSnapshot = () =>
    validateRisuContent({
      ...value.package,
      title: value.title,
      description: value.description,
      body: value.text,
    });
  async function saveContent(copyKind?: 'bot' | 'persona' | 'module') {
    if (editorUnavailable || portraitBusy || (!state.creationPending && !value.title.trim()))
      return false;
    const version = ++saveVersion.current;
    onError('');
    setSaved('');
    setSaveWarnings([]);
    setError('');
    try {
      const copying = !!copyKind;
      const result = state.creationPending
        ? await session.save()
        : await session.save(
            {
              kind: copyKind ?? value.kind,
              title: copying ? value.title + t('shared.copySuffix') : value.title,
              description: value.description,
              text: value.text,
              loading: value.loading,
              relatedIds: [],
              package: copying
                ? withNativeContentTitle(packageSnapshot(), value.title + t('shared.copySuffix'))
                : packageSnapshot(),
            } satisfies ContentEditModel,
            { copy: copying }
          );
      const item = result.saved as Content;
      setSaved(descriptor('library.savedResource', { title: item.title }));
      if (result.creationIntent) {
        setPlacing(true);
        try {
          await onCreated?.(item, result.creationOrganizationRevision ?? null);
        } catch {
          setSaveWarnings((warnings) => [
            ...warnings,
            descriptor('library.savedPlacementWarning', { title: item.title }),
          ]);
        }
      }
      void Promise.resolve()
        .then(reload)
        .catch(() => {
          if (saveVersion.current === version)
            setSaveWarnings((warnings) => [
              ...warnings,
              descriptor('library.savedRefreshWarning', { title: item.title }),
            ]);
        });
      return !session.snapshot().dirty;
    } catch (caught) {
      requestResourceConflictReview(session);
      const message = errorDescriptor(caught);
      setError(message);
      onError(message);
      return false;
    } finally {
      setPlacing(false);
    }
  }
  const saveButton = useRef<HTMLButtonElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const titleErrorId = useId();
  const [titleTouched, setTitleTouched] = useState(false);
  const titleMissing = !state.creationPending && !value.title.trim();
  const titleError = titleMissing && titleTouched;
  const editorRoot = useRef<HTMLElement>(null);
  const requestTitle = () => {
    setTitleTouched(true);
    titleField.current?.focus();
  };
  useShortcut('editor.save', requestTitle, { scope: editorRoot, active: titleMissing });
  useEditorSaveCommand(shared.session, () => {
    if (!titleMissing) return saveContent();
    requestTitle();
    return Promise.resolve(false);
  });
  const ready = state.ready;
  useEffect(() => {
    if (ready && !initial) titleField.current?.focus();
  }, [ready, initial]);
  if (!state.ready) return <ResourceEditorStatus value={shared} />;
  return (
    <ResourceEditorProvider value={shared} saveButton={saveButton}>
      <section
        ref={editorRoot}
        className="library-detail library-content-editor"
        aria-label={t('library.resourceDetails')}
        aria-busy={editorUnavailable}
      >
        <EditorStudio
          label={t('native.text_b891876a9a')}
          sections={sections}
          changed={changes}
          value={section}
          onSelect={selectSection}
          idPrefix={sectionId}
          header={
            <div className="library-detail-heading">
              {headerLeading}
              <IconButton
                className="secondary"
                label={t('library.libraryList')}
                icon={BackIcon}
                disabled={editorUnavailable}
                onClick={onClose}
              />
              <div className="editor-title">
                <h2 className="editor-title-field">
                  <input
                    ref={titleField}
                    aria-label={t('library.resourceName', { v0: t(contentLabelKeys[value.kind]) })}
                    aria-invalid={titleError || undefined}
                    aria-describedby={titleError ? titleErrorId : undefined}
                    placeholder={t('library.new', { v0: t(contentLabelKeys[kind]) })}
                    maxLength={200}
                    disabled={editorUnavailable}
                    value={value.title}
                    onChange={(event) => {
                      const title = event.target.value;
                      setTitleTouched(true);
                      setValue((current) => ({
                        ...current,
                        title,
                        package: withNativeContentTitle(current.package, title),
                      }));
                    }}
                  />
                </h2>
                {titleError && (
                  <small id={titleErrorId} className="editor-title-error" role="alert">
                    {t('library.nameRequired')}
                  </small>
                )}
              </div>
              <div className="library-detail-actions">
                <ResourceEditorActions
                  value={shared}
                  commands={commands}
                  hideSyncError
                  changes={
                    <EditorChanges
                      commands={commands}
                      changes={changes}
                      current={value}
                      subject={value.title}
                      sectionOf={sectionOf}
                      save={{
                        run: () => {
                          if (!titleMissing) return saveContent();
                          setTitleTouched(true);
                          return Promise.resolve(false);
                        },
                        label: selected ? t('library.saveChanges') : t('library.registerResource'),
                        disabled: editorUnavailable || portraitBusy || state.creationPending,
                        error: titleMissing ? t('library.nameRequired') : error,
                      }}
                      onReveal={(target) => {
                        selectSection(target.section);
                        setReveal({
                          section: target.section,
                          item: target.item,
                          field: target.field,
                          range: { from: target.offset ?? 0, to: target.offset ?? 0 },
                          epoch: ++revealEpoch.current,
                        });
                      }}
                    />
                  }
                />
                {selected && canUse(category) && (
                  <button
                    type="button"
                    className="secondary editor-start-chat"
                    disabled={savedVersionBusy}
                    onClick={() => onUse(selected, category)}
                  >
                    <RoleActionIcon role={category} />
                    <span>
                      {category === 'bot' ? t('library.startChat') : roleActionLabel(category)}
                    </span>
                  </button>
                )}
                <SaveButton
                  ref={saveButton}
                  type={state.creationPending ? 'button' : 'submit'}
                  form={formId}
                  className="primary native-editor-save"
                  disabled={
                    editorUnavailable ||
                    portraitBusy ||
                    (!state.creationPending &&
                      (!value.title.trim() || (!!selected && !dirty && !nativeDraftDirty)))
                  }
                  aria-busy={busy}
                  label={
                    state.creationPending
                      ? t('main.m130')
                      : selected
                        ? t('library.saveChanges')
                        : t('library.registerResource')
                  }
                  text={
                    state.creationPending
                      ? t('main.m130')
                      : selected
                        ? t('shared.save')
                        : t('library.register')
                  }
                  onClick={state.creationPending ? () => void saveContent() : undefined}
                />
                <LibraryItemMenu title={t('library.resourceMenu')}>
                  <PreviousVersionAction
                    commands={commands}
                    subject={value.title}
                    sections={(paths) => contentChanges(sections, paths)}
                    sectionOf={sectionOf}
                    authored={authoredContentModel}
                  />
                  {selected && (
                    <div className="action-menu-group">
                      {category === 'bot' && onConfigureChat && (
                        <button
                          type="button"
                          disabled={savedVersionBusy}
                          onClick={() => onConfigureChat(selected)}
                        >
                          <NewChatIcon size={18} aria-hidden="true" />
                          {t('transfer.configureNewChat')}
                        </button>
                      )}
                      {libraryTabs
                        .filter(({ id }) => id !== category && canUse(id))
                        .map(({ id }) => (
                          <button
                            type="button"
                            key={id}
                            disabled={savedVersionBusy}
                            onClick={() => onUse(selected, id)}
                          >
                            <RoleActionIcon role={id} />
                            {roleActionLabel(id)}
                          </button>
                        ))}
                      {recentChat && onContinueChat && (
                        <button
                          type="button"
                          disabled={savedVersionBusy}
                          onClick={() => onContinueChat(recentChat)}
                        >
                          <HistoryIcon size={18} aria-hidden="true" />
                          {t('library.continueRecentChat')}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="action-menu-group">
                    {selected && (
                      <button
                        type="button"
                        disabled={savedVersionBusy || moving}
                        onClick={() => onDuplicate(selected)}
                      >
                        <CopyIcon size={18} aria-hidden="true" />
                        {t('library.duplicate')}
                      </button>
                    )}
                    {(['bot', 'persona', 'module'] as const)
                      .filter((role) => role !== value.kind)
                      .map((role) => (
                        <button
                          type="button"
                          key={role}
                          disabled={
                            editorUnavailable ||
                            state.creationPending ||
                            !value.title.trim() ||
                            nativeDraftDirty ||
                            portraitBusy
                          }
                          onClick={() => void saveContent(role)}
                        >
                          <CopyIcon size={18} aria-hidden="true" />
                          {t('library.copyAs', { kind: role, role: t(contentLabelKeys[role]) })}
                        </button>
                      ))}
                    {selected && (
                      <RisuExportButton
                        kind="content"
                        linkedModules={!!selected.package?.modules?.length}
                        format={
                          selected.kind === 'module' &&
                          !Object.keys(selected.package?.nativeRisu.card ?? {}).length
                            ? 'RISUM'
                            : 'CHARX'
                        }
                        id={selected.id}
                        revision={selected.revision}
                        title={selected.title}
                        disabled={editorUnavailable || dirty || nativeDraftDirty || portraitBusy}
                        onError={setExportError}
                      />
                    )}
                    {selected && (
                      <button
                        type="button"
                        disabled={editorUnavailable || moving}
                        onClick={() => onMove(selected)}
                      >
                        <MoveIcon size={18} aria-hidden="true" />
                        {t('library.moveCategoryOrFolder')}
                      </button>
                    )}
                  </div>
                  {selected && (
                    <div className="action-menu-group">
                      <DeleteButton
                        endpoint={deletionEndpoints.deleteContent}
                        params={{ id: selected.id }}
                        revision={selected.revision}
                        title={selected.title}
                        label={t('library.deleteResource')}
                        disabled={editorUnavailable}
                        description={t('library.removeThisResourceFromTheListAnd')}
                        onError={onError}
                        onDeleted={async () => {
                          forgetBotStorage(selected.id);
                          onDeleted();
                          await reload();
                        }}
                      />
                    </div>
                  )}
                </LibraryItemMenu>
              </div>
              {headerTrailing}
            </div>
          }
          notice={
            <>
              <RestoredVersionNotice commands={commands} />
              <DismissibleError error={exportError} onDismiss={() => setExportError('')} />
            </>
          }
        >
          <form
            id={formId}
            className="editor-grid"
            onSubmit={async (event) => {
              event.preventDefault();
              await saveContent();
            }}
          >
            <fieldset className="editor-fields full" disabled={editorUnavailable}>
              <CodeFieldBaseContext value={codeBases}>
                <RisuNativeFields
                  anchor={anchor}
                  section={section}
                  onSelect={selectSection}
                  idPrefix={sectionId}
                  saved={selected && { id: selected.id, revision: selected.revision }}
                  reveal={reveal}
                  value={value.package}
                  onChange={(pkg) =>
                    setValue((current) => ({ ...current, title: pkg.title, package: pkg }))
                  }
                  onPortraitBusy={setPortraitBusy}
                  overview={
                    <ContentOverviewMeta
                      category={selected ? category : null}
                      folder={folder}
                      counts={sections.filter((item) => !!item.count)}
                    />
                  }
                />
              </CodeFieldBaseContext>
            </fieldset>
            {error && (
              <p className="error full" role="alert">
                {translateMessage(error)}
              </p>
            )}
            <TransientNotice content={saved} />
            {!!saveWarnings.length && (
              <NoticeBanner className="full" label={t('library.reviewAfterSaving')}>
                {saveWarnings.map((warning) => (
                  <p key={translateMessage(warning)}>{translateMessage(warning)}</p>
                ))}
              </NoticeBanner>
            )}
          </form>
        </EditorStudio>
      </section>
    </ResourceEditorProvider>
  );
}
