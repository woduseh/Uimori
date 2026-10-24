import {
  t,
  useI18n,
  translateMessage,
  getLocale,
  message as uiMessage,
  messageRef,
} from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { NoticeBanner } from './NoticeBanner.js';
import { DismissibleError } from './DismissibleError.js';
import { TransientNotice } from './TransientNotice.js';
import { SaveButton } from './SaveButton.js';
import { RisuNativeFields } from './RisuNativeFields.js';
import { RisuExportButton } from './RisuExportButton.js';
import { IconButton } from './IconButton.js';
import { useEditorHeadingHeight } from './useEditorHeadingHeight.js';
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
} from './resource-editor.js';
import {
  editableResource,
  type ContentEditModel,
  type ResourceSaveResult,
} from '../core/resource-editing.js';
import { ResourceEditorSession } from './resource-editor-session.js';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import type { Content, ContentKind, Library } from '../core/product.js';
import type { LibraryItemKey, LibraryOrganization } from '../core/library-organization.js';
import { libraryCategory, libraryFolderOf } from '../core/library-organization.js';
import { api } from './api.js';
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
  ListIcon,
  ModuleIcon,
  MoveIcon,
  NewChatIcon,
  OptionsIcon,
  PersonaIcon,
  SearchIcon,
  SelectIcon,
  DownIcon,
  UpIcon,
} from './ui-icons.js';
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
const contentGuidance: Record<PrimaryLibraryTab, { descriptionKey: string; exampleKey: string }> = {
  bot: {
    descriptionKey: 'library.yourConversationPartner',
    exampleKey: 'library.describeTheirPersonalityAndVoiceToCreate',
  },
  persona: {
    descriptionKey: 'library.aPersonaIsTheCharacterYouPlay',
    exampleKey: 'library.describeYourNameBackgroundAndHowOthers',
  },
  module: {
    descriptionKey: 'library.modulesAddSettingsAndInstructionsToConversations',
    exampleKey: 'library.createWorldsStylesAndSharedRulesFor',
  },
};
type ViewMode = 'cards' | 'list';
type SortMode = LibrarySort;
type CardRatio = '1:1' | '2:3' | '3:4' | '9:16';
const cardRatios: CardRatio[] = ['1:1', '2:3', '3:4', '9:16'];
function savedViews(): Record<PrimaryLibraryTab, ViewMode> {
  const defaults: Record<PrimaryLibraryTab, ViewMode> = {
    bot: 'cards',
    persona: 'cards',
    module: 'list',
  };
  try {
    const stored = JSON.parse(localStorage.getItem('uimori-library-views') ?? '{}') as Record<
      string,
      unknown
    >;
    for (const { id } of libraryTabs)
      if (stored[id] === 'cards' || stored[id] === 'list') defaults[id] = stored[id];
  } catch {
    /* A restricted browser still has sensible defaults. */
  }
  return defaults;
}
function savedCardRatios(): Record<PrimaryLibraryTab, CardRatio> {
  const defaults: Record<PrimaryLibraryTab, CardRatio> = {
    bot: '1:1',
    persona: '1:1',
    module: '1:1',
  };
  try {
    const stored = JSON.parse(localStorage.getItem('uimori-library-card-ratios') ?? '{}') as Record<
      string,
      unknown
    >;
    for (const { id } of libraryTabs)
      if (cardRatios.includes(stored[id] as CardRatio)) defaults[id] = stored[id] as CardRatio;
  } catch {
    /* A restricted browser still has sensible defaults. */
  }
  return defaults;
}
function savedSorts(): Record<PrimaryLibraryTab, SortMode> {
  const defaults: Record<PrimaryLibraryTab, SortMode> = {
    bot: 'name',
    persona: 'name',
    module: 'name',
  };
  try {
    const stored = JSON.parse(localStorage.getItem('uimori-library-sorts') ?? '{}') as Record<
      string,
      unknown
    >;
    for (const { id } of libraryTabs)
      if (stored[id] === 'name' || stored[id] === 'name-desc' || stored[id] === 'manual')
        defaults[id] = stored[id];
  } catch {
    /* A restricted browser still has sensible defaults. */
  }
  return defaults;
}
function savedManualOrders(): Record<PrimaryLibraryTab, string[]> {
  const defaults: Record<PrimaryLibraryTab, string[]> = { bot: [], persona: [], module: [] };
  try {
    const stored = JSON.parse(
      localStorage.getItem('uimori-library-manual-orders') ?? '{}'
    ) as Record<string, unknown>;
    for (const { id } of libraryTabs)
      if (Array.isArray(stored[id]))
        defaults[id] = stored[id].filter((value): value is string => typeof value === 'string');
  } catch {
    /* A restricted browser still has sensible defaults. */
  }
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
  onTabChange,
  onDirtyChange,
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
  /** Bumped when the navigation entry is chosen, so the same tab still returns to its list. */
  listRequest?: number;
  onTabChange?: (tab: PrimaryLibraryTab) => void;
  onDirtyChange?: (dirty: boolean) => void;
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
  const [detail, setDetail] = useState<Content | null>(null);
  const [loading, setLoading] = useState(false);
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ kind: 'folder' | 'item'; id: string } | null>(
    null
  );
  const panelRef = useRef<HTMLElement>(null);
  const draggedItem = useRef<string | null>(null);
  const selectionExit = useRef<HTMLButtonElement>(null);
  const wasSelecting = useRef(false);
  const opening = useRef(0);
  const cloning = useRef(false);
  const latestLibrary = useRef(library);
  latestLibrary.current = library;
  const externalTab = useRef(initialTab);
  const organizer = useLibraryOrganization(library, reload, onError);
  // The list and detail share a scrollport. A newly opened resource must start at its heading,
  // not at the list position retained by the browser.
  useLayoutEffect(() => {
    if (detail || editing)
      panelRef.current?.closest<HTMLElement>('.destination-scroll')?.scrollTo({ top: 0 });
  }, [detail, editing]);
  const organizedLibrary = library
    ? { ...library, organization: organizer.organization ?? library.organization }
    : null;
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only an explicit request leaves a detail view.
  useEffect(() => {
    if (externalList.current === listRequest) return;
    externalList.current = listRequest;
    // `navigate` returns early when the list is already showing and asks to keep an unsaved draft.
    navigate(initialTab);
  }, [listRequest]);
  useEffect(() => {
    if (
      folder !== 'all' &&
      folder !== 'unclassified' &&
      organizer.organization &&
      !organizer.organization.folders.some((item) => item.id === folder && item.category === tab)
    )
      setFolder('all');
  }, [folder, organizer.organization, tab]);
  useEffect(() => {
    if (!library) {
      setSelectedIds([]);
      setMoving(null);
      return;
    }
    const currentLibrary = {
      ...library,
      organization: organizer.organization ?? library.organization,
    };
    const available = new Set(
      library.contents
        .filter((item) => {
          const folderId = libraryFolderOf(currentLibrary, { kind: 'content', id: item.id });
          return (
            libraryCategory(currentLibrary, item) === tab &&
            ((folder === 'all' && (!!query.trim() || folderId === null)) ||
              (folder === 'unclassified' ? folderId === null : folderId === folder))
          );
        })
        .map((item) => item.id)
    );
    setSelectedIds((current) => current.filter((id) => available.has(id)));
    setMoving((current) => (current?.some((item) => !available.has(item.id)) ? null : current));
    setDetail((current) =>
      current && !library.contents.some((item) => item.id === current.id) ? null : current
    );
  }, [library, organizer.organization, tab, folder, query]);
  function cancelOpening() {
    opening.current++;
    setLoading(false);
  }
  function switchTab(next: PrimaryLibraryTab, closeOnly = false) {
    cancelOpening();
    setEditing(null);
    setDetail(null);
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
    if (next === tab && !closeOnly && !editing && !detail) return;
    if (dirty) setPendingNavigation({ tab: next, closeOnly });
    else switchTab(next, closeOnly);
  }
  function continueEditing() {
    setPendingNavigation(null);
    externalTab.current = tab;
    onTabChange?.(tab);
  }
  async function placeCreated(item: Content, cloned = false) {
    const folderId = folder === 'all' || folder === 'unclassified' ? null : folder;
    if ((!cloned && item.kind !== tab) || (folderId === null && item.kind === tab)) return;
    const current = await api<LibraryOrganization>('/library/organization');
    const placed = await organizer.mutate(
      '/library/organization/move',
      { items: [{ kind: 'content', id: item.id }], category: tab, folderId },
      'POST',
      current.revision
    );
    if (!placed) throw new Error(uiMessage('library.couldNotCompleteFolderPlacement'));
  }
  async function openContent(
    item: Content,
    action: 'detail' | 'edit' | 'clone' | 'configure-chat' | PrimaryLibraryTab = 'detail'
  ) {
    if (action === 'clone') {
      if (cloning.current) return;
      cloning.current = true;
    }
    const request = ++opening.current;
    setLoading(true);
    try {
      const cached = detail && refValue(detail) === refValue(item) ? detail : null;
      const full =
        cached ??
        (action !== 'clone' && (library?.contentBodiesOmitted || (item.hasPackage && !item.package))
          ? await api<Content>(`/content/${item.id}`)
          : item);
      if (
        request !== opening.current ||
        !latestLibrary.current?.contents.some((current) => current.id === item.id)
      )
        return;
      if (action === 'edit') {
        setDetail(null);
        setEditing({ kind: full.kind, item: full });
      } else if (action === 'clone') {
        const result = await api<ResourceSaveResult>('/resources/clone', {
          kind: 'content',
          sourceId: full.id,
          expectedSourceRevision: full.revision,
          title: `${full.title.slice(0, 197).replace(/[\uD800-\uDBFF]$/u, '')} 사본`,
        });
        const copy = result.saved as Content;
        const warnings: string[] = [];
        try {
          await placeCreated(copy, true);
        } catch (error) {
          warnings.push(
            uiMessage('library.theResourceWasCopiedButCouldNot', {
              v0: messageRef((error as Error).message),
            })
          );
        }
        try {
          await reload();
        } catch (error) {
          warnings.push(
            uiMessage('library.theResourceWasCopiedButTheList', {
              v0: messageRef((error as Error).message),
            })
          );
        }
        if (request === opening.current) {
          setDetail(null);
          setEditing({ kind: copy.kind, item: copy });
          if (warnings.length)
            onError(
              warnings.length === 1
                ? warnings[0]
                : uiMessage('library.cloneWarnings', {
                    first: messageRef(warnings[0]),
                    second: messageRef(warnings[1]),
                  })
            );
        }
      } else if (action === 'detail') setDetail(full);
      else if (action === 'configure-chat') onConfigureStartStory?.(full);
      else if (onUseContent) onUseContent(full, action);
      else if (action === 'bot') onStartStory?.(full);
    } catch (error) {
      if (request === opening.current) onError((error as Error).message);
    } finally {
      if (action === 'clone') cloning.current = false;
      if (request === opening.current) setLoading(false);
    }
  }
  function openNew() {
    cancelOpening();
    setDetail(null);
    setEditing({ kind: tab, item: null });
  }
  const categoryItems =
    organizedLibrary?.contents.filter((item) => libraryCategory(organizedLibrary, item) === tab) ??
    [];
  const counts: Record<string, number> = { all: categoryItems.length };
  for (const item of categoryItems) {
    const key =
      libraryFolderOf(organizedLibrary!, { kind: 'content', id: item.id }) ?? 'unclassified';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const sort = sortByTab[tab];
  const manualOrder = manualOrderByTab[tab];
  const filtered = categoryItems
    .filter((item) => {
      const folderId = libraryFolderOf(organizedLibrary!, { kind: 'content', id: item.id });
      return (
        ((folder === 'all' && (!!query.trim() || folderId === null)) ||
          (folder === 'unclassified' ? folderId === null : folderId === folder)) &&
        `${item.title} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      );
    })
    .sort((a, b) => {
      if (sort !== 'manual')
        return (sort === 'name-desc' ? -1 : 1) * a.title.localeCompare(b.title, getLocale());
      const aIndex = manualOrder.indexOf(a.id);
      const bIndex = manualOrder.indexOf(b.id);
      return (
        (aIndex < 0 ? Number.MAX_SAFE_INTEGER : aIndex) -
          (bIndex < 0 ? Number.MAX_SAFE_INTEGER : bIndex) ||
        a.title.localeCompare(b.title, getLocale())
      );
    });
  const folders = organizer.organization?.folders.filter((item) => item.category === tab) ?? [];
  const showFolders = folder === 'all' && !query.trim() && !selecting;
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
    try {
      localStorage.setItem('uimori-library-views', JSON.stringify(next));
    } catch {
      /* Keep this session's choice. */
    }
  }
  function setSort(mode: SortMode) {
    const next = { ...sortByTab, [tab]: mode };
    setSortByTab(next);
    saveLibrarySort(tab, mode);
  }
  function saveManualOrder(ids: string[]) {
    const next = { ...manualOrderByTab, [tab]: ids };
    setManualOrderByTab(next);
    saveLibraryManualOrder(tab, ids);
  }
  function orderedCategoryIds() {
    const ids = new Set(categoryItems.map((item) => item.id));
    return [
      ...manualOrder.filter((id) => ids.has(id)),
      ...categoryItems
        .filter((item) => !manualOrder.includes(item.id))
        .sort((a, b) => a.title.localeCompare(b.title, getLocale()))
        .map((item) => item.id),
    ];
  }
  function moveManualItem(id: string, beforeId: string | null) {
    const ordered = orderedCategoryIds().filter((itemId) => itemId !== id);
    const index = beforeId === null ? ordered.length : ordered.indexOf(beforeId);
    ordered.splice(index < 0 ? ordered.length : index, 0, id);
    saveManualOrder(ordered);
  }
  function moveManualByOffset(item: Content, offset: number) {
    const index = filtered.findIndex((entry) => entry.id === item.id);
    const target = filtered[index + offset];
    if (!target) return;
    if (offset < 0) moveManualItem(item.id, target.id);
    else moveManualItem(item.id, filtered[index + 2]?.id ?? null);
  }
  function startDragging(item: Content, event: DragEvent<HTMLElement>) {
    if (selecting || organizer.busy) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
    draggedItem.current = item.id;
    setDraggedItemId(item.id);
  }
  function clearDragging() {
    draggedItem.current = null;
    setDraggedItemId(null);
    setDropTarget(null);
  }
  function dragOverItem(item: Content, event: DragEvent<HTMLElement>) {
    const id = draggedItem.current;
    if (sort !== 'manual' || !id || id === item.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget({ kind: 'item', id: item.id });
  }
  function dropOnItem(item: Content, event: DragEvent<HTMLElement>) {
    const id = draggedItem.current;
    if (sort !== 'manual' || !id || id === item.id) return;
    event.preventDefault();
    moveManualItem(id, item.id);
    clearDragging();
  }
  function dragOverFolder(folderId: string, event: DragEvent<HTMLElement>) {
    if (!draggedItem.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget({ kind: 'folder', id: folderId });
  }
  function dragLeaveFolder(folderId: string, event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropTarget((current) =>
      current?.kind === 'folder' && current.id === folderId ? null : current
    );
  }
  async function dropOnFolder(folderId: string, event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const id = draggedItem.current;
    clearDragging();
    if (!id || libraryFolderOf(organizedLibrary!, { kind: 'content', id }) === folderId) return;
    await organizer.mutate('/library/organization/move', {
      items: [{ kind: 'content', id }],
      category: tab,
      folderId,
    });
  }
  function setCardRatio(ratio: CardRatio) {
    const next = { ...cardRatioByTab, [tab]: ratio };
    setCardRatioByTab(next);
    try {
      localStorage.setItem('uimori-library-card-ratios', JSON.stringify(next));
    } catch {
      /* Keep this session's choice. */
    }
  }
  function itemMenu(item: Content) {
    const manualIndex = filtered.findIndex((entry) => entry.id === item.id);
    return (
      <LibraryItemMenu title={t('library.menu', { v0: item.title })}>
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
              disabled={manualIndex === 0}
              onClick={() => moveManualByOffset(item, -1)}
            >
              <UpIcon size={18} aria-hidden="true" />
              {t('library.moveUp')}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={manualIndex === filtered.length - 1}
              onClick={() => moveManualByOffset(item, 1)}
            >
              <DownIcon size={18} aria-hidden="true" />
              {t('library.moveDown')}
            </button>
          </>
        )}
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => void openContent(item, 'clone')}
        >
          <CopyIcon size={18} aria-hidden="true" />
          {t('library.duplicate')}
        </button>
        <DeleteButton
          path={`/content/${encodeURIComponent(item.id)}`}
          revision={item.revision}
          title={item.title}
          onDeleted={async () => {
            cancelOpening();
            await reload();
          }}
          onError={onError}
        />
      </LibraryItemMenu>
    );
  }
  const detailRole: PrimaryLibraryTab = detail
    ? organizedLibrary
      ? libraryCategory(organizedLibrary, detail)
      : detail.kind === 'persona'
        ? 'persona'
        : detail.kind === 'module'
          ? 'module'
          : 'bot'
    : tab;
  const detailFolderId =
    detail && organizedLibrary
      ? libraryFolderOf(organizedLibrary, { kind: 'content', id: detail.id })
      : null;
  const detailFolder = detailFolderId
    ? organizer.organization?.folders.find((item) => item.id === detailFolderId)?.title
    : undefined;
  const detailCounts = detail?.package
    ? [
        [t('library.lore'), detail.package.lore.length],
        [t('library.images'), detail.package.images?.length ?? 0],
      ]
        .filter(([, count]) => (count as number) > 0)
        .map(([label, count]) =>
          t('library.labelCount', { label: String(label), count: Number(count) })
        )
    : [];
  const roleActionLabel = (id: PrimaryLibraryTab, title: string) =>
    id === 'bot'
      ? t('library.newChatAsBot')
      : id === 'persona'
        ? t('library.useAsPersona')
        : t('library.addAs', { v0: title });
  const roleActionIcon = (id: PrimaryLibraryTab) =>
    id === 'bot' ? NewChatIcon : id === 'persona' ? PersonaIcon : ModuleIcon;
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
              onError((error as Error).message);
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
          onStartStory={onStartStory}
          onCreated={placeCreated}
          headerLeading={headerLeading}
          headerTrailing={headerTrailing}
        />
      ) : detail ? (
        <section
          className="library-detail library-preview"
          aria-label={t('library.resourceDetails')}
        >
          <div className="library-detail-heading">
            <IconButton
              className="secondary"
              label={t('library.libraryList')}
              icon={BackIcon}
              onClick={() => navigate(tab, true)}
            />
            <div className="library-detail-actions">
              <IconButton
                icon={EditIcon}
                label={t('library.edit')}
                disabled={loading}
                onClick={() => void openContent(detail, 'edit')}
              />
              <LibraryItemMenu title={t('library.menu', { v0: detail.title })}>
                {detailRole === 'bot' && onConfigureStartStory && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={loading}
                    onClick={() => void openContent(detail, 'configure-chat')}
                  >
                    <NewChatIcon size={18} aria-hidden="true" />
                    {t('transfer.configureNewChat')}
                  </button>
                )}
                {libraryTabs
                  .filter(({ id }) => id !== detailRole)
                  .map(({ id, titleKey }) => (
                    <button
                      type="button"
                      className="secondary"
                      key={id}
                      aria-label={roleActionLabel(id, t(titleKey))}
                      disabled={
                        loading || (id === 'bot' ? !onUseContent && !onStartStory : !onUseContent)
                      }
                      onClick={() => void openContent(detail, id)}
                    >
                      {(() => {
                        const Icon = roleActionIcon(id);
                        return <Icon size={18} aria-hidden="true" />;
                      })()}
                      {roleActionLabel(id, t(titleKey))}
                    </button>
                  ))}
                <button
                  type="button"
                  className="secondary"
                  disabled={loading}
                  onClick={() => void openContent(detail, 'clone')}
                >
                  <CopyIcon size={18} aria-hidden="true" />
                  {t('library.duplicate')}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={organizer.busy}
                  onClick={() => setMoving([{ kind: 'content', id: detail.id }])}
                >
                  <MoveIcon size={18} aria-hidden="true" />
                  {t('library.moveCategoryOrFolder')}
                </button>
                <DeleteButton
                  path={`/content/${encodeURIComponent(detail.id)}`}
                  revision={detail.revision}
                  title={detail.title}
                  onDeleted={async () => {
                    cancelOpening();
                    await reload();
                    navigate(tab, true);
                  }}
                  onError={onError}
                />
              </LibraryItemMenu>
            </div>
          </div>
          <div className="library-preview-heading">
            <ContentAvatar content={detail} className="library-preview-avatar" />
            <div>
              <h2>{detail.title}</h2>
              <small className="ui-meta-row">
                <span>
                  {organizedLibrary
                    ? t(contentLabelKeys[libraryCategory(organizedLibrary, detail)])
                    : t(contentLabelKeys[detail.kind])}
                </span>
                {detailFolder && <span>{detailFolder}</span>}
              </small>
              {detail.description && <p>{detail.description}</p>}
            </div>
          </div>
          <div className="library-use-actions">
            <button
              type="button"
              aria-label={roleActionLabel(detailRole, t(contentLabelKeys[detailRole]))}
              disabled={
                loading || (detailRole === 'bot' ? !onUseContent && !onStartStory : !onUseContent)
              }
              onClick={() => void openContent(detail, detailRole)}
            >
              <NewChatIcon size={18} aria-hidden="true" />
              {detailRole === 'bot'
                ? t('library.newChat')
                : roleActionLabel(detailRole, t(contentLabelKeys[detailRole]))}
            </button>
            {recentChatByContent?.[detail.id] && onContinueChat && (
              <button
                type="button"
                className="secondary"
                onClick={() => onContinueChat(recentChatByContent[detail.id])}
              >
                {t('library.continueRecentChat')}
              </button>
            )}
          </div>
          {detail.package && detailCounts.length > 0 && (
            <p className="library-preview-counts muted ui-meta-row">
              {detailCounts.map((count, index) => (
                <span key={index}>{count}</span>
              ))}
            </p>
          )}
          {detail.text && <div className="library-preview-body">{detail.text}</div>}
        </section>
      ) : (
        <>
          <div
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
          </div>
          <div className="library-workspace">
            <div className="library-workspace-content">
              <div className="library-toolbar">
                {!selecting && (
                  <LibraryFolders
                    presentation="breadcrumb"
                    category={tab}
                    organizer={organizer}
                    value={folder}
                    onChange={changeFolder}
                    counts={counts}
                    reload={reload}
                    onError={onError}
                  />
                )}
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
                      onClick={() => setSelectedIds(filtered.map((item) => item.id))}
                    >
                      <SelectIcon size={18} aria-hidden="true" />
                      <span>{t('library.selectAll')}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={t('library.moveSelectedResources')}
                      disabled={!selectedIds.length || organizer.busy}
                      onClick={() => setMoving(selectedIds.map((id) => ({ kind: 'content', id })))}
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
                    {!categoryEmpty && (
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
                            <label>
                              {t('library.sort')}
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
                    <RisuImport
                      defaultKind={tab === 'bot' ? '' : tab}
                      reload={reload}
                      onContinueChat={onContinueChat}
                    />
                  </>
                )}
                {!selecting && (filtered.length > 0 || !!query) && (
                  <button
                    type="button"
                    className="library-create primary ui-icon-button"
                    aria-label={t('library.create', { v0: t(contentLabelKeys[tab]) })}
                    title={t('library.create', { v0: t(contentLabelKeys[tab]) })}
                    onClick={openNew}
                    disabled={!library}
                  >
                    <AddIcon size={18} aria-hidden="true" />
                  </button>
                )}
              </div>
              {!!query && !selecting && (
                <p className="library-result-count muted" role="status">
                  {t('library.resultCount', { count: filtered.length })}
                </p>
              )}
              {showFolders && folders.length > 0 && (
                <section className="library-folder-section" aria-label={t('library.folderList')}>
                  <h2>{t('library.folders')}</h2>
                  <LibraryFolders
                    presentation="cards"
                    view={views[tab]}
                    category={tab}
                    organizer={organizer}
                    value={folder}
                    onChange={changeFolder}
                    counts={counts}
                    reload={reload}
                    onError={onError}
                    draggedItemId={draggedItemId}
                    dropFolderId={dropTarget?.kind === 'folder' ? dropTarget.id : null}
                    onFolderDragOver={dragOverFolder}
                    onFolderDragLeave={dragLeaveFolder}
                    onFolderDrop={(folderId, event) => void dropOnFolder(folderId, event)}
                  />
                </section>
              )}
              {folder === 'all' && !query.trim() && folders.length > 0 && filtered.length > 0 && (
                <h2 className="library-section-title">
                  {t('library.uncategorizedRole', { role: t(contentLabelKeys[tab]) })}
                </h2>
              )}
              <div
                id="library-results"
                role="tabpanel"
                aria-labelledby={`library-tab-${tab}`}
                className={
                  views[tab] === 'cards' ? 'library-cards library-portrait-cards' : 'library-list'
                }
                data-card-ratio={views[tab] === 'cards' ? cardRatioByTab[tab] : undefined}
              >
                {filtered.map((item) => (
                  <article
                    className={
                      views[tab] === 'cards'
                        ? 'library-card library-portrait-card'
                        : 'library-list-item'
                    }
                    key={item.id}
                    data-library-item-id={item.id}
                    data-has-portrait={
                      item.kind === 'module' ? undefined : !!contentPortraitUrl(item)
                    }
                    data-selected={selecting && selectedIds.includes(item.id) ? 'true' : undefined}
                    data-selecting={selecting ? 'true' : undefined}
                    data-dragging={draggedItemId === item.id ? 'true' : undefined}
                    data-drop-target={
                      dropTarget?.kind === 'item' && dropTarget.id === item.id ? 'true' : undefined
                    }
                    draggable={!selecting && !organizer.busy}
                    onDragStart={(event) => startDragging(item, event)}
                    onDragEnd={clearDragging}
                    onDragOver={(event) => dragOverItem(item, event)}
                    onDrop={(event) => dropOnItem(item, event)}
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
                        action: selecting ? 'select' : 'detail',
                      })}
                      aria-pressed={selecting ? selectedIds.includes(item.id) : undefined}
                      onClick={() =>
                        selecting ? toggleSelection(item.id) : void openContent(item)
                      }
                      disabled={loading}
                    >
                      <ContentAvatar content={item} className="library-item-avatar" />
                      <span className="library-item-copy">
                        <strong title={item.title}>{item.title}</strong>
                        {item.description && <span>{item.description}</span>}
                        {!!query.trim() && folder === 'all' && (
                          <small className="library-result-folder">
                            {folders.find(
                              (entry) =>
                                entry.id ===
                                libraryFolderOf(organizedLibrary!, { kind: 'content', id: item.id })
                            )?.title ?? t('library.uncategorized')}
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
                ))}
                {filtered.length === 0 &&
                  !(
                    (folder === 'all' || folder === 'unclassified') &&
                    !query.trim() &&
                    categoryItems.length > 0
                  ) && (
                    <div className="library-empty">
                      <h2>
                        {query
                          ? t('library.noMatchingResources')
                          : folder !== 'all'
                            ? t('library.thisFolderIsEmpty')
                            : folders.length > 0
                              ? t('library.noUncategorizedResources')
                              : t('library.noRegisteredResourcesYet')}
                      </h2>
                      {!query && categoryItems.length === 0 && (
                        <p className="library-role-guide">
                          {t(contentGuidance[tab].descriptionKey)}
                        </p>
                      )}
                      <div className="library-empty-actions">
                        {query && (
                          <button type="button" className="secondary" onClick={() => setQuery('')}>
                            {t('library.clearSearch')}
                          </button>
                        )}
                        {folder !== 'all' && (
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => changeFolder('all')}
                          >
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
                  )}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
function ContentEditor({
  reload,
  onError,
  initial,
  kind,
  onClose,
  onDeleted,
  onStartStory,
  onDirtyChange,
  onCreated,
  headerLeading,
  headerTrailing,
}: EditorProps & {
  initial: Content | null;
  kind: ContentKind;
  onClose: () => void;
  onDeleted: () => void;
  onStartStory?: (bot: Content) => void;
  onDirtyChange: (dirty: boolean) => void;
  onCreated?: (content: Content) => Promise<void>;
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
  const selected = document.targetId
    ? {
        ...(document.baseModel as ContentEditModel),
        id: document.targetId,
        revision: document.baseRevision!,
      }
    : null;
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
  const editorHeading = useEditorHeadingHeight(state.ready);
  useEffect(() => {
    onDirtyChange(dirty || busy || portraitBusy);
  }, [dirty, busy, portraitBusy, onDirtyChange]);
  const packageSnapshot = () =>
    validateRisuContent({
      ...value.package,
      title: value.title,
      description: value.description,
      body: value.text,
    });
  async function saveContent(copyKind?: 'bot' | 'persona' | 'module') {
    if (editorUnavailable || portraitBusy || !value.title.trim()) return false;
    const version = ++saveVersion.current;
    onError('');
    setSaved('');
    setSaveWarnings([]);
    setError('');
    try {
      const copying = !!copyKind;
      const pkg = copying
        ? withNativeContentTitle(packageSnapshot(), value.title + ' 사본')
        : packageSnapshot();
      const model: ContentEditModel = {
        kind: copyKind ?? value.kind,
        title: copying ? value.title + ' 사본' : value.title,
        description: value.description,
        text: value.text,
        loading: value.loading,
        relatedIds: [],
        package: pkg,
      };
      const item = (await session.save(model, { copy: copying })).saved as Content;
      setSaved(uiMessage('library.savedResource', { title: item.title }));
      if (!selected || copying) {
        setPlacing(true);
        try {
          await onCreated?.(item);
        } catch {
          setSaveWarnings((warnings) => [
            ...warnings,
            uiMessage('library.savedPlacementWarning', { title: item.title }),
          ]);
        }
      }
      // The durable save is complete. A list refresh must not keep the editor locked
      // or turn an acknowledged save into an apparent failed/retryable write.
      void Promise.resolve()
        .then(reload)
        .catch(() => {
          if (saveVersion.current === version)
            setSaveWarnings((warnings) => [
              ...warnings,
              uiMessage('library.savedRefreshWarning', { title: item.title }),
            ]);
        });
      return !session.snapshot().dirty;
    } catch (caught) {
      requestResourceConflictReview(session);
      const message = (caught as Error).message;
      setError(message);
      onError(message);
      return false;
    } finally {
      setPlacing(false);
    }
  }
  useEditorSaveCommand(shared.session, () => saveContent());
  if (!state.ready) return <ResourceEditorStatus value={shared} />;
  return (
    <ResourceEditorProvider value={shared}>
      <section
        className="library-detail library-content-editor"
        aria-label={t('library.resourceDetails')}
        aria-busy={editorUnavailable}
      >
        <div ref={editorHeading} className="library-detail-heading">
          {headerLeading}
          <IconButton
            className="secondary"
            label={t('library.libraryList')}
            icon={BackIcon}
            disabled={editorUnavailable}
            onClick={onClose}
          />
          <h2>{selected ? selected.title : t('library.new', { v0: t(contentLabelKeys[kind]) })}</h2>
          <div className="library-detail-actions">
            <ResourceEditorActions value={shared} hideSyncError />
            <SaveButton
              type="submit"
              form={formId}
              className="primary native-editor-save"
              disabled={editorUnavailable || !value.title.trim() || portraitBusy}
              aria-busy={busy}
              label={selected ? t('library.saveChanges') : t('library.registerResource')}
              text={selected ? t('shared.save') : t('library.register')}
            />
            <LibraryItemMenu title={t('library.resourceMenu')}>
              {(['bot', 'persona', 'module'] as const)
                .filter((role) => role !== value.kind)
                .map((role) => (
                  <button
                    type="button"
                    key={role}
                    disabled={
                      editorUnavailable || !value.title.trim() || nativeDraftDirty || portraitBusy
                    }
                    onClick={() => void saveContent(role)}
                  >
                    <CopyIcon size={18} aria-hidden="true" />
                    {t('library.copyAs', { role: t(contentLabelKeys[role]) })}
                  </button>
                ))}
              {selected && (
                <>
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
                  <DeleteButton
                    path={`/content/${encodeURIComponent(selected.id)}`}
                    revision={selected.revision}
                    title={selected.title}
                    label={t('library.deleteResource')}
                    disabled={editorUnavailable}
                    description={t('library.removeThisResourceFromTheListAnd')}
                    onError={onError}
                    onDeleted={async () => {
                      onDeleted();
                      await reload();
                    }}
                  />
                </>
              )}
            </LibraryItemMenu>
          </div>
          {headerTrailing}
          <DismissibleError message={exportError} onDismiss={() => setExportError('')} />
        </div>
        <form
          id={formId}
          className="editor-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            await saveContent();
          }}
        >
          <fieldset className="editor-fields full" disabled={editorUnavailable}>
            <RisuNativeFields
              value={value.package}
              onChange={(pkg) =>
                setValue((current) => ({ ...current, title: pkg.title, package: pkg }))
              }
              onPortraitBusy={setPortraitBusy}
            />
          </fieldset>
          {error && (
            <p className="error full" role="alert">
              {t('library.errorInputRetained', { error: translateMessage(error) })}
            </p>
          )}
          {nativeDraftDirty && (
            <p className="full muted">{t('library.editingTheOriginalChangesWillBeChecked')}</p>
          )}
          <div className="library-savebar form-actions full">
            {selected && (selected.kind === 'bot' || selected.package) && onStartStory && (
              <button
                type="button"
                disabled={editorUnavailable || dirty || nativeDraftDirty || portraitBusy}
                onClick={() => onStartStory(selected)}
              >
                {selected.kind === 'bot'
                  ? t('library.startChat')
                  : t('library.startWithThisResourceAsBot')}
              </button>
            )}
          </div>
          <TransientNotice message={saved} />
          {!!saveWarnings.length && (
            <NoticeBanner className="full" label={t('library.reviewAfterSaving')}>
              {saveWarnings.map((warning) => (
                <p key={translateMessage(warning)}>{translateMessage(warning)}</p>
              ))}
            </NoticeBanner>
          )}
        </form>
      </section>
    </ResourceEditorProvider>
  );
}
