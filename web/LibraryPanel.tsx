import { SelectionCheckbox } from './BooleanControls.js';
import { PackageTransfer } from './PackageTransfer.js';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Content, ContentKind, Library } from '../core/product.js';
import type { LibraryItemKey, LibraryOrganization } from '../core/library-organization.js';
import { libraryCategory, libraryFolderOf } from '../core/library-organization.js';
import { api } from './api.js';
import { refValue } from './content-ref.js';
import { PackageFields, packageFromContent } from './PackageFields.js';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import { DeleteButton } from './DeleteButton.js';
import { Dialog } from './Dialog.js';
import { ContentAvatar } from './ContentAvatar.js';
import { PackagePortraitEditor } from './PackagePortraitEditor.js';
import { IconButton } from './IconButton.js';
import {
  AddIcon,
  BotIcon,
  CardsIcon,
  CloseIcon,
  CopyIcon,
  EditIcon,
  ListIcon,
  ModuleIcon,
  MoveIcon,
  NewChatIcon,
  PersonaIcon,
  SearchIcon,
  SelectIcon,
} from './ui-icons.js';
import {
  LibraryFolders,
  LibraryItemMenu,
  LibraryMoveDialog,
  useLibraryOrganization,
  type FolderFilter,
} from './LibraryFolders.js';
import './library.css';

export const contentLabels: Record<ContentKind, string> = {
  bot: '봇',
  persona: '페르소나',
  module: '모듈',
};
const freshContent = (kind: ContentKind): Omit<Content, 'id' | 'revision'> => ({
  kind,
  title: '',
  description: '',
  text: '',
  loading: 'pinned',
  relatedIds: [],
  package: packageFromContent({ title: '', description: '', text: '' }),
});
type EditorProps = {
  library: Library;
  reload: () => Promise<void>;
  onError: (error: string) => void;
};
export type PrimaryLibraryTab = 'bot' | 'persona' | 'module';
const libraryTabs: { id: PrimaryLibraryTab; title: string; icon: typeof BotIcon }[] = [
  { id: 'bot', title: '봇', icon: BotIcon },
  { id: 'persona', title: '페르소나', icon: PersonaIcon },
  { id: 'module', title: '모듈', icon: ModuleIcon },
];
const contentGuidance: Record<PrimaryLibraryTab, { description: string; example: string }> = {
  bot: {
    description: '함께 이야기할 상대예요.',
    example: '성격과 말투를 적어 나만의 대화 상대를 만들어 보세요.',
  },
  persona: {
    description: '페르소나는 내가 맡을 인물이에요.',
    example: '이름과 배경, 상대가 나를 어떻게 부를지 적어 보세요.',
  },
  module: {
    description: '모듈은 대화에 더할 설정·지침이에요.',
    example: '세계관, 문체, 함께 지킬 규칙을 만들어 여러 채팅에 더할 수 있어요.',
  },
};
type ViewMode = 'cards' | 'list';
function savedViews(): Record<PrimaryLibraryTab, ViewMode> {
  const defaults: Record<PrimaryLibraryTab, ViewMode> = {
    bot: 'list',
    persona: 'list',
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
export function LibraryPanel({
  library,
  reload,
  onError,
  onStartStory,
  onUseContent,
  initialTab = 'bot',
  onTabChange,
  onDirtyChange,
  recentChatByContent,
  onContinueChat,
  headerLeading,
}: {
  library: Library | null;
  reload: () => Promise<void>;
  onError: (error: string) => void;
  onStartStory?: (bot: Content) => void;
  onUseContent?: (content: Content, role: PrimaryLibraryTab) => void;
  initialTab?: PrimaryLibraryTab;
  onTabChange?: (tab: PrimaryLibraryTab) => void;
  onDirtyChange?: (dirty: boolean) => void;
  recentChatByContent?: Record<string, string>;
  onContinueChat?: (chatId: string) => void;
  headerLeading?: ReactNode;
}) {
  const [tab, setTab] = useState(initialTab);
  const [dirty, setDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<{
    tab: PrimaryLibraryTab;
    closeOnly?: boolean;
  } | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('name');
  const [views, setViews] = useState(savedViews);
  const [folder, setFolder] = useState<FolderFilter>('all');
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moving, setMoving] = useState<LibraryItemKey[] | null>(null);
  const [editing, setEditing] = useState<{ kind: ContentKind; item: Content | null } | null>(null);
  const [detail, setDetail] = useState<Content | null>(null);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const selectionExit = useRef<HTMLButtonElement>(null);
  const wasSelecting = useRef(false);
  const opening = useRef(0);
  const latestLibrary = useRef(library);
  latestLibrary.current = library;
  const continueButton = useRef<HTMLButtonElement>(null);
  const externalTab = useRef(initialTab);
  const organizer = useLibraryOrganization(library, reload, onError);
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
    if (pendingNavigation) continueButton.current?.focus();
  }, [pendingNavigation]);
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
            (folder === 'all' ||
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
  }, [library, organizer.organization, tab, folder]);
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
  async function placeCreated(item: Content) {
    if (folder === 'all' || folder === 'unclassified' || item.kind !== tab) return;
    const current = await api<LibraryOrganization>('/library/organization');
    await organizer.mutate(
      '/library/organization/move',
      { items: [{ kind: 'content', id: item.id }], category: tab, folderId: folder },
      'POST',
      current.revision
    );
  }
  async function openContent(
    item: Content,
    action: 'detail' | 'edit' | 'clone' | PrimaryLibraryTab = 'detail'
  ) {
    const request = ++opening.current;
    setLoading(true);
    try {
      const cached = detail && refValue(detail) === refValue(item) ? detail : null;
      const full =
        cached ??
        (library?.contentBodiesOmitted || (item.hasPackage && !item.package)
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
        const copy = await api<Content>('/content', {
          kind: tab,
          title: `${full.title} 사본`,
          description: full.description,
          text: full.text,
          loading: full.loading,
          relatedIds: [],
          ...(full.package ? { package: { ...full.package, title: `${full.title} 사본` } } : {}),
        });
        await placeCreated(copy);
        await reload();
        if (request === opening.current) {
          setDetail(null);
          setEditing({ kind: copy.kind, item: copy });
        }
      } else if (action === 'detail') setDetail(full);
      else if (onUseContent) onUseContent(full, action);
      else if (action === 'bot') onStartStory?.(full);
    } catch (error) {
      if (request === opening.current) onError((error as Error).message);
    } finally {
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
  const filtered = categoryItems
    .filter((item) => {
      const folderId = libraryFolderOf(organizedLibrary!, { kind: 'content', id: item.id });
      return (
        (folder === 'all' ||
          (folder === 'unclassified' ? folderId === null : folderId === folder)) &&
        `${item.title} ${item.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      );
    })
    .sort((a, b) => (sort === 'name-desc' ? -1 : 1) * a.title.localeCompare(b.title, 'ko'));
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
  function itemMenu(item: Content) {
    return (
      <LibraryItemMenu title={`${item.title} 메뉴`}>
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => void openContent(item, 'edit')}
        >
          <EditIcon size={18} aria-hidden="true" />
          편집
        </button>
        <button
          type="button"
          className="secondary"
          disabled={organizer.busy}
          onClick={() => setMoving([{ kind: 'content', id: item.id }])}
        >
          <MoveIcon size={18} aria-hidden="true" />
          분류·폴더 이동
        </button>
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => void openContent(item, 'clone')}
        >
          <CopyIcon size={18} aria-hidden="true" />
          복제
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
        ['로어', detail.package.lore.length],
        ['지침', detail.package.instructions.length],
        ['이미지', detail.package.images?.length ?? 0],
      ]
        .filter(([, count]) => (count as number) > 0)
        .map(([label, count]) => `${label} ${count}`)
    : [];
  const roleActionLabel = (id: PrimaryLibraryTab, title: string) =>
    id === 'bot' ? '봇으로 새 채팅' : id === 'persona' ? '페르소나로 사용' : `${title}로 추가`;
  return (
    <section ref={panelRef} className="library-page" data-testid="library-panel" aria-label="서재">
      <header className="library-heading">
        {headerLeading}
        <h1>서재</h1>
        {!editing && !detail && (!library || filtered.length > 0 || !!query) && (
          <button type="button" className="library-create" onClick={openNew} disabled={!library}>
            <AddIcon size={20} aria-hidden="true" />
            <span>새로 만들기</span>
          </button>
        )}
      </header>
      <Dialog
        open={!!pendingNavigation}
        title="미저장 자료 확인"
        role="alertdialog"
        className="library-discard-dialog"
        onClose={continueEditing}
      >
        <p>저장하지 않은 편집 내용이 있어요.</p>
        <p className="muted">이동하면 현재 초안이 사라져요.</p>
        <div className="library-discard-actions">
          <button
            type="button"
            className="secondary"
            ref={continueButton}
            onClick={continueEditing}
          >
            계속 편집
          </button>
          <button
            type="button"
            onClick={() => {
              if (!pendingNavigation) return;
              switchTab(pendingNavigation.tab, pendingNavigation.closeOnly);
              setPendingNavigation(null);
            }}
          >
            초안 버리고 이동
          </button>
        </div>
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
      {loading && <p role="status">자료 본문을 불러오는 중이에요…</p>}
      {!library ? (
        <p role="status">서재를 불러오는 중이에요…</p>
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
        />
      ) : detail ? (
        <section className="library-detail library-preview" aria-label="자료 상세">
          <div className="library-detail-heading">
            <button type="button" className="secondary" onClick={() => navigate(tab, true)}>
              ← 서재 목록
            </button>
            <div className="library-detail-title">
              <h2>{detail.title}</h2>
              <small>
                {organizedLibrary
                  ? contentLabels[libraryCategory(organizedLibrary, detail)]
                  : contentLabels[detail.kind]}
                {detailFolder ? ` · ${detailFolder}` : ''}
              </small>
            </div>
            <div className="library-detail-actions">
              <button
                type="button"
                className="secondary"
                disabled={loading}
                onClick={() => void openContent(detail, 'edit')}
              >
                <EditIcon size={18} aria-hidden="true" />
                편집
              </button>
              <LibraryItemMenu title={`${detail.title} 메뉴`}>
                {libraryTabs
                  .filter(({ id }) => id !== detailRole)
                  .map(({ id, title }) => (
                    <button
                      type="button"
                      className="secondary"
                      key={id}
                      aria-label={roleActionLabel(id, title)}
                      disabled={
                        loading || (id === 'bot' ? !onUseContent && !onStartStory : !onUseContent)
                      }
                      onClick={() => void openContent(detail, id)}
                    >
                      {roleActionLabel(id, title)}
                    </button>
                  ))}
                <button
                  type="button"
                  className="secondary"
                  disabled={loading}
                  onClick={() => void openContent(detail, 'clone')}
                >
                  <CopyIcon size={18} aria-hidden="true" />
                  복제
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={organizer.busy}
                  onClick={() => setMoving([{ kind: 'content', id: detail.id }])}
                >
                  <MoveIcon size={18} aria-hidden="true" />
                  분류·폴더 이동
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
              <p>{detail.description || '아직 소개가 없어요.'}</p>
            </div>
          </div>
          <div className="library-use-actions">
            <button
              type="button"
              aria-label={roleActionLabel(detailRole, contentLabels[detailRole])}
              disabled={
                loading || (detailRole === 'bot' ? !onUseContent && !onStartStory : !onUseContent)
              }
              onClick={() => void openContent(detail, detailRole)}
            >
              <NewChatIcon size={18} aria-hidden="true" />
              {detailRole === 'bot'
                ? '새 채팅'
                : roleActionLabel(detailRole, contentLabels[detailRole])}
            </button>
            {recentChatByContent?.[detail.id] && onContinueChat && (
              <button
                type="button"
                className="secondary"
                onClick={() => onContinueChat(recentChatByContent[detail.id])}
              >
                최근 채팅 이어가기
              </button>
            )}
          </div>
          {detail.package && detailCounts.length > 0 && (
            <p className="library-preview-counts muted">{detailCounts.join(' · ')}</p>
          )}
          {detail.text && <div className="library-preview-body">{detail.text}</div>}
        </section>
      ) : (
        <>
          <div
            className="library-tabs"
            role="tablist"
            aria-label="서재 분류"
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
                {item.title}
              </button>
            ))}
          </div>
          <div className="library-workspace">
            <div className="library-workspace-content">
              <div className="library-toolbar">
                <LibraryFolders
                  category={tab}
                  organizer={organizer}
                  value={folder}
                  onChange={(next) => {
                    setFolder(next);
                    setSelectedIds([]);
                  }}
                  counts={counts}
                  reload={reload}
                  onError={onError}
                />
                {selecting ? (
                  <div className="library-bulk-toolbar" role="group" aria-label="자료 선택 작업">
                    <span role="status">{selectedIds.length}개 선택</span>
                    <button
                      type="button"
                      className="secondary"
                      aria-label="표시된 자료 전체 선택"
                      onClick={() => setSelectedIds(filtered.map((item) => item.id))}
                    >
                      <SelectIcon size={18} aria-hidden="true" />
                      <span>전체</span>
                    </button>
                    <button
                      type="button"
                      aria-label="선택한 자료 이동"
                      disabled={!selectedIds.length || organizer.busy}
                      onClick={() => setMoving(selectedIds.map((id) => ({ kind: 'content', id })))}
                    >
                      <MoveIcon size={18} aria-hidden="true" />
                      <span>이동</span>
                    </button>
                    <IconButton
                      ref={selectionExit}
                      label="선택 취소"
                      icon={CloseIcon}
                      onClick={() => {
                        setSelectedIds([]);
                        setSelecting(false);
                      }}
                    />
                  </div>
                ) : (
                  <>
                    {!categoryEmpty && (
                      <>
                        <label className="library-search-field">
                          <SearchIcon size={20} aria-hidden="true" />
                          <span className="sr-only">서재 검색</span>
                          <input
                            type="search"
                            aria-label="서재 검색"
                            placeholder="이름이나 설명으로 찾기"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                          />
                        </label>
                        <LibraryItemMenu
                          title="목록 관리"
                          className="library-list-options"
                          icon={SlidersHorizontal}
                        >
                          <div className="library-list-options-body">
                            <label>
                              정렬
                              <select
                                aria-label="자료 정렬"
                                value={sort}
                                onChange={(event) => setSort(event.target.value)}
                              >
                                <option value="name">이름순</option>
                                <option value="name-desc">이름 역순</option>
                              </select>
                            </label>
                            <div
                              className="library-view-buttons"
                              role="group"
                              aria-label="자료 보기"
                            >
                              <button
                                type="button"
                                className="secondary"
                                aria-pressed={views[tab] === 'cards'}
                                onClick={() => setView('cards')}
                              >
                                <CardsIcon size={18} aria-hidden="true" />
                                카드
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                aria-pressed={views[tab] === 'list'}
                                onClick={() => setView('list')}
                              >
                                <ListIcon size={18} aria-hidden="true" />
                                목록
                              </button>
                            </div>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => {
                                setSelecting(true);
                                setSelectedIds([]);
                              }}
                            >
                              <SelectIcon size={18} aria-hidden="true" />
                              선택
                            </button>
                          </div>
                        </LibraryItemMenu>
                      </>
                    )}
                  </>
                )}
              </div>
              {!!query && !selecting && (
                <p className="library-result-count muted" role="status">
                  검색 결과 {filtered.length}개
                </p>
              )}
              <div
                id="library-results"
                role="tabpanel"
                aria-labelledby={`library-tab-${tab}`}
                className={
                  views[tab] === 'cards' ? 'library-cards library-portrait-cards' : 'library-list'
                }
              >
                {filtered.map((item) => (
                  <article
                    className={
                      views[tab] === 'cards'
                        ? 'library-card library-portrait-card'
                        : 'library-list-item'
                    }
                    key={item.id}
                  >
                    {selecting && (
                      <label className="library-select-check">
                        <span className="sr-only">{item.title} 선택</span>
                        <SelectionCheckbox
                          aria-label={`${item.title} 선택`}
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
                      aria-label={`${item.title} 상세 보기`}
                      onClick={() => void openContent(item)}
                      disabled={loading}
                    >
                      <ContentAvatar content={item} className="library-item-avatar" />
                      <span className="library-item-copy">
                        <strong title={item.title}>{item.title}</strong>
                        <span>{item.description || '아직 소개가 없어요.'}</span>
                      </span>
                    </button>
                    {!selecting && tab === 'bot' && (onUseContent || onStartStory) && (
                      <button
                        type="button"
                        className="secondary library-start-chat"
                        disabled={loading}
                        aria-label={`${item.title} 새 채팅`}
                        onClick={() => void openContent(item, 'bot')}
                      >
                        <NewChatIcon size={20} aria-hidden="true" />
                        <span>새 채팅</span>
                      </button>
                    )}
                    {!selecting && itemMenu(item)}
                  </article>
                ))}
                {filtered.length === 0 && (
                  <div className="library-empty">
                    <h2>
                      {query
                        ? '찾는 자료가 없어요'
                        : folder !== 'all'
                          ? '이 폴더는 비어 있어요'
                          : `새 ${contentLabels[tab]} 만들기`}
                    </h2>
                    {!query && (
                      <p className="library-role-guide">{contentGuidance[tab].description}</p>
                    )}
                    <p>
                      {query
                        ? '다른 이름이나 설명으로 찾아보세요.'
                        : folder !== 'all'
                          ? '자료를 만들거나 다른 폴더의 자료를 옮겨 보세요.'
                          : contentGuidance[tab].example}
                    </p>
                    {query && (
                      <button type="button" className="secondary" onClick={() => setQuery('')}>
                        검색 지우기
                      </button>
                    )}
                    {folder !== 'all' && (
                      <button type="button" className="secondary" onClick={() => setFolder('all')}>
                        이 탭 전체에서 찾기
                      </button>
                    )}
                    {!query && (
                      <button type="button" onClick={openNew}>
                        <AddIcon size={20} aria-hidden="true" />
                        {contentLabels[tab]} 만들기
                      </button>
                    )}
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
  library,
  reload,
  onError,
  initial,
  kind,
  onClose,
  onDeleted,
  onStartStory,
  onDirtyChange,
  onCreated,
}: EditorProps & {
  initial: Content | null;
  kind: ContentKind;
  onClose: () => void;
  onDeleted: () => void;
  onStartStory?: (bot: Content) => void;
  onDirtyChange: (dirty: boolean) => void;
  onCreated?: (content: Content) => Promise<void>;
}) {
  const [selected, setSelected] = useState(initial);
  const [value, setValue] = useState<Omit<Content, 'id' | 'revision'>>(
    initial ?? freshContent(kind)
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [baseline, setBaseline] = useState(() => JSON.stringify(initial ?? freshContent(kind)));
  const [importedPackage, setImportedPackage] = useState<ContentPackage | null>(null);
  const [behaviorDraftDirty, setBehaviorDraftDirty] = useState(false);
  const [portraitBusy, setPortraitBusy] = useState(false);
  const dirty = JSON.stringify(value) !== baseline;
  useEffect(() => {
    onDirtyChange(dirty || !!importedPackage || behaviorDraftDirty || portraitBusy);
  }, [dirty, importedPackage, behaviorDraftDirty, portraitBusy, onDirtyChange]);
  const packageSnapshot = () =>
    validateContentPackage({
      ...value.package,
      title: value.title,
      description: value.description,
      body: value.text,
    });
  async function saveContent(copyKind?: 'bot' | 'persona' | 'module') {
    if (portraitBusy) return;
    if (behaviorDraftDirty) {
      setError('패키지의 초안을 먼저 검증하고 적용해 주세요.');
      return;
    }
    setBusy(true);
    onError('');
    setSaved('');
    setError('');
    try {
      const copying = !!copyKind;
      const pkg = value.package
        ? packageSnapshot()
        : copying
          ? packageFromContent(value)
          : undefined;
      const item = await api<Content>(
        !copying && selected ? '/content/' + selected.id : '/content',
        {
          kind: copyKind ?? value.kind,
          title: copying ? value.title + ' 사본' : value.title,
          description: value.description,
          text: value.text,
          loading: value.loading,
          relatedIds: [],
          ...(pkg ? { package: pkg } : {}),
          ...(!copying && selected ? { expectedRevision: selected.revision } : {}),
        },
        !copying && selected ? 'PUT' : 'POST'
      );
      setSelected(item);
      setValue(item);
      setBaseline(JSON.stringify(item));
      setSaved(item.title + ' 저장됨 · 다음 실행부터 사용해요.');
      if (!selected || copying) await onCreated?.(item);
      await reload();
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="library-detail" aria-label="자료 상세">
      <div className="library-detail-heading">
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>
          ← 서재 목록
        </button>
        <h2>{selected ? selected.title : `새 ${contentLabels[kind]}`}</h2>
        <div className="library-detail-actions">
          {selected && (
            <LibraryItemMenu title="자료 메뉴">
              <DeleteButton
                path={`/content/${encodeURIComponent(selected.id)}`}
                revision={selected.revision}
                title={selected.title}
                label="자료 삭제"
                disabled={busy}
                description="이 자료를 목록에서 삭제하고 현재 편집 초안을 닫아요. 과거 채팅과 실행이 사용하는 내용은 유지돼요."
                onError={onError}
                onDeleted={async () => {
                  onDeleted();
                  await reload();
                }}
              />
            </LibraryItemMenu>
          )}
        </div>
      </div>
      <p className="library-editor-guide">
        {contentGuidance[value.kind].description} {contentGuidance[value.kind].example}
      </p>
      <form
        className="editor-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          await saveContent();
        }}
      >
        <fieldset className="editor-fields full" disabled={busy}>
          <label className="full">
            이름
            <input
              aria-label="자료 이름"
              value={value.title}
              maxLength={160}
              required
              onChange={(event) => setValue({ ...value, title: event.target.value })}
            />
          </label>
          <label className="full">
            {value.kind === 'bot'
              ? '성격과 대화 지침'
              : value.kind === 'persona'
                ? '내 인물의 설정'
                : '더할 설정과 지침'}
            <textarea
              aria-label="자료 본문"
              rows={5}
              value={value.text}
              maxLength={100000}
              required={!value.package}
              onChange={(event) => setValue({ ...value, text: event.target.value })}
            />
          </label>
          <label className="full">
            짧은 소개 · 선택
            <input
              aria-label="자료 설명"
              value={value.description}
              maxLength={1000}
              placeholder="서재 목록에 보여줄 한 줄 소개"
              onChange={(event) => setValue({ ...value, description: event.target.value })}
            />
          </label>
          {value.package && (
            <details className="library-editor-extra full">
              <summary>대표 이미지 · 선택</summary>
              <div className="library-editor-extra-body">
                <PackagePortraitEditor
                  value={value.package}
                  onChange={(pkg) => setValue((current) => ({ ...current, package: pkg }))}
                  onDirtyChange={setPortraitBusy}
                  disabled={busy}
                />
              </div>
            </details>
          )}
          <details className="library-editor-extra full">
            <summary>분류·읽기 설정</summary>
            <div className="library-editor-extra-body">
              <label>
                서재 분류
                <select
                  aria-label="자료 종류"
                  value={selected ? libraryCategory(library, selected) : value.kind}
                  disabled={!!selected}
                  onChange={(event) => {
                    const next = event.target.value as ContentKind;
                    setValue({
                      ...value,
                      kind: next,
                      loading: freshContent(next).loading,
                      ...(!value.package && ['bot', 'persona', 'module'].includes(next)
                        ? { package: packageFromContent(value) }
                        : {}),
                    });
                  }}
                >
                  {Object.entries(contentLabels).map(([key, title]) => (
                    <option key={key} value={key}>
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                이 자료를 읽는 방법
                <select
                  aria-label="기본 로딩"
                  value={value.loading}
                  onChange={(event) =>
                    setValue({ ...value, loading: event.target.value as Content['loading'] })
                  }
                >
                  <option value="pinned">항상 포함</option>
                  <option value="discoverable">모델이 필요할 때 읽기</option>
                </select>
              </label>
            </div>
          </details>
          <details className="library-editor-extra full">
            <summary>고급 패키지 설정</summary>
            <div className="library-editor-extra-body">
              <p className="muted">로어, 시작 장면, 역할별 지침과 동작을 더할 수 있어요.</p>
              {value.package ? (
                <PackageFields
                  value={value.package}
                  onChange={(pkg) => setValue((current) => ({ ...current, package: pkg }))}
                  onBehaviorDraftChange={setBehaviorDraftDirty}
                />
              ) : (
                ['bot', 'persona', 'module'].includes(value.kind) && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setValue({ ...value, package: packageFromContent(value) })}
                  >
                    공통 패키지로 확장
                  </button>
                )
              )}
            </div>
          </details>
          <details className="library-package-tools full">
            <summary>패키지 가져오기·내보내기와 역할 사본</summary>
            <div className="library-package-tools-body">
              <PackageTransfer
                getPackage={packageSnapshot}
                onPrepared={(pkg) => {
                  setImportedPackage(pkg);
                  setError('');
                }}
                onError={setError}
                disabled={behaviorDraftDirty}
              />
              {importedPackage && (
                <div className="library-import-preview">
                  <p>
                    {importedPackage.title} · 로어 {importedPackage.lore.length}개 · 지침{' '}
                    {importedPackage.instructions.length}개
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setValue({
                        ...value,
                        title: importedPackage.title,
                        description: importedPackage.description,
                        text: importedPackage.body ?? '',
                        package: importedPackage,
                      });
                      setImportedPackage(null);
                    }}
                  >
                    가져온 패키지로 초안 바꾸기
                  </button>
                  <button type="button" className="ghost" onClick={() => setImportedPackage(null)}>
                    가져오기 취소
                  </button>
                </div>
              )}
              <section className="library-package-copies">
                <h3>다른 역할로 사본 만들기</h3>
                <p className="muted">
                  로어와 지침을 함께 복사해요. 인물 관점과 역할별 지침은 직접 조정해 주세요.
                </p>
                {!value.title.trim() && (
                  <p className="muted">자료 이름을 입력하면 사본을 만들 수 있어요.</p>
                )}
                <div className="form-actions">
                  {(['bot', 'persona', 'module'] as const)
                    .filter((role) => role !== value.kind)
                    .map((role) => (
                      <button
                        type="button"
                        className="secondary"
                        key={role}
                        disabled={!value.title.trim()}
                        onClick={() => void saveContent(role)}
                      >
                        {contentLabels[role]}로 사본 만들기
                      </button>
                    ))}
                </div>
              </section>
            </div>
          </details>
        </fieldset>
        {error && (
          <p className="error full" role="alert">
            {error} 입력한 내용은 유지했어요.
          </p>
        )}
        {behaviorDraftDirty && (
          <p className="full muted">
            패키지에 미적용 초안이 있어요. 검증 후 적용하면 자료를 저장할 수 있어요.
          </p>
        )}
        <div className="library-savebar form-actions full">
          {selected && (selected.kind === 'bot' || selected.package) && onStartStory && (
            <button
              type="button"
              disabled={busy || dirty || !!importedPackage || behaviorDraftDirty || portraitBusy}
              onClick={() => onStartStory(selected)}
            >
              {selected.kind === 'bot' ? '채팅 시작' : '이 자료를 봇으로 시작'}
            </button>
          )}
          <button
            className={selected ? 'secondary' : ''}
            disabled={busy || !!importedPackage || behaviorDraftDirty || portraitBusy}
          >
            {busy ? '저장 중…' : selected ? '변경사항 저장' : '자료 등록'}
          </button>
          <span role="status">{saved}</span>
        </div>
        {selected && (
          <>
            <small className="full">
              저장하면 이 자료를 사용하는 채팅의 다음 실행부터 반영돼요. 이전 설정을 유지하려면
              복제해 주세요.
            </small>
            <details className="library-diagnostics full">
              <summary>자료 저장 정보</summary>

              <code>{selected.id}</code>
            </details>
          </>
        )}
      </form>
    </section>
  );
}
