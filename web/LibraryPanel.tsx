import { PackageTransfer } from './PackageTransfer.js';
import { useEffect, useRef, useState } from 'react';
import type { Content, ContentKind, Library } from '../core/product.js';
import type { LibraryItemKey, LibraryOrganization } from '../core/library-organization.js';
import { libraryCategory, libraryFolderOf } from '../core/library-organization.js';
import { api } from './api.js';
import { PackageFields, packageFromContent } from './PackageFields.js';
import { validateContentPackage, type ContentPackage } from '../core/content-package.js';
import { DeleteButton } from './DeleteButton.js';
import { Dialog } from './Dialog.js';
import { ContentAvatar } from './ContentAvatar.js';
import { PackagePortraitEditor } from './PackagePortraitEditor.js';
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
export const refValue = (item: { id: string; revision: number }) => `${item.id}@${item.revision}`;
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
const libraryTabs: { id: PrimaryLibraryTab; title: string }[] = [
  { id: 'bot', title: '봇' },
  { id: 'persona', title: '페르소나' },
  { id: 'module', title: '모듈' },
];
type ViewMode = 'cards' | 'list';
function savedViews(): Record<PrimaryLibraryTab, ViewMode> {
  const defaults: Record<PrimaryLibraryTab, ViewMode> = {
    bot: 'cards',
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
          ? await api<Content>(`/revisions/content/${item.id}/${item.revision}`)
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
  const currentFolderTitle =
    folder === 'all'
      ? '전체'
      : folder === 'unclassified'
        ? '미분류'
        : (organizer.organization?.folders.find((item) => item.id === folder)?.title ?? '전체');
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
          편집
        </button>
        <button
          type="button"
          className="secondary"
          disabled={organizer.busy}
          onClick={() => setMoving([{ kind: 'content', id: item.id }])}
        >
          분류·폴더 이동
        </button>
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => void openContent(item, 'clone')}
        >
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
  return (
    <section className="library-page" data-testid="library-panel" aria-label="서재">
      <header className="library-heading">
        <div>
          <h1>서재</h1>
          <p className="muted">함께 이야기할 캐릭터와 세계를 모아 두세요.</p>
        </div>
        {!editing && !detail && (
          <button type="button" className="secondary" onClick={openNew} disabled={!library}>
            새로 만들기
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
            <div className="library-detail-actions">
              <button
                type="button"
                className="secondary"
                disabled={loading}
                onClick={() => void openContent(detail, 'edit')}
              >
                편집
              </button>
              {itemMenu(detail)}
            </div>
          </div>
          <div className="library-preview-heading">
            <ContentAvatar content={detail} className="library-preview-avatar" />
            <div>
              <small>
                {organizedLibrary
                  ? contentLabels[libraryCategory(organizedLibrary, detail)]
                  : contentLabels[detail.kind]}
              </small>
              <h2>{detail.title}</h2>
              <p>{detail.description || '아직 소개가 없어요.'}</p>
            </div>
          </div>
          <div className="library-use-actions">
            {libraryTabs.map(({ id, title }) => (
              <button
                type="button"
                className={id === 'bot' ? '' : 'secondary'}
                key={id}
                disabled={
                  loading || (id === 'bot' ? !onUseContent && !onStartStory : !onUseContent)
                }
                onClick={() => void openContent(detail, id)}
              >
                {id === 'bot'
                  ? '봇으로 새 채팅'
                  : id === 'persona'
                    ? '페르소나로 사용'
                    : `${title}로 추가`}
              </button>
            ))}
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
          <p className="muted">
            선택한 역할로 사용해도 서재의 분류는 바뀌지 않아요. 역할별 지침은 편집에서 확인할 수
            있어요.
          </p>
          {detail.text && <div className="library-preview-body">{detail.text}</div>}
          {detail.package && (
            <dl className="library-preview-facts">
              <div>
                <dt>로어</dt>
                <dd>{detail.package.lore.length}개</dd>
              </div>
              <div>
                <dt>지침</dt>
                <dd>{detail.package.instructions.length}개</dd>
              </div>
              <div>
                <dt>이미지</dt>
                <dd>{detail.package.images?.length ?? 0}개</dd>
              </div>
            </dl>
          )}
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
                {item.title}
              </button>
            ))}
          </div>
          <div className="library-workspace">
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
            <div className="library-workspace-content">
              <div className="library-toolbar">
                <label className="library-search-field">
                  <span className="sr-only">서재 검색</span>
                  <input
                    type="search"
                    aria-label="서재 검색"
                    placeholder="이름이나 설명으로 찾기"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <label>
                  <span className="sr-only">자료 정렬</span>
                  <select
                    aria-label="자료 정렬"
                    value={sort}
                    onChange={(event) => setSort(event.target.value)}
                  >
                    <option value="name">이름순</option>
                    <option value="name-desc">이름 역순</option>
                  </select>
                </label>
                <div className="library-view-buttons" role="group" aria-label="자료 보기">
                  <button
                    type="button"
                    className="secondary"
                    aria-pressed={views[tab] === 'cards'}
                    onClick={() => setView('cards')}
                  >
                    카드
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-pressed={views[tab] === 'list'}
                    onClick={() => setView('list')}
                  >
                    목록
                  </button>
                </div>
                <button
                  type="button"
                  className="secondary"
                  aria-pressed={selecting}
                  onClick={() => {
                    setSelecting(!selecting);
                    setSelectedIds([]);
                  }}
                >
                  선택
                </button>
              </div>
              <p className="library-result-count muted">
                {currentFolderTitle} · {filtered.length}개{query ? ` · “${query}” 검색` : ''}
              </p>
              {selecting && (
                <div className="library-bulk-toolbar">
                  <span>{selectedIds.length}개 선택</span>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setSelectedIds(filtered.map((item) => item.id))}
                  >
                    표시된 자료 전체 선택
                  </button>
                  <button
                    type="button"
                    disabled={!selectedIds.length || organizer.busy}
                    onClick={() => setMoving(selectedIds.map((id) => ({ kind: 'content', id })))}
                  >
                    선택한 자료 이동
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setSelectedIds([]);
                      setSelecting(false);
                    }}
                  >
                    선택 취소
                  </button>
                </div>
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
                        <input
                          type="checkbox"
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
                    {itemMenu(item)}
                    <button
                      type="button"
                      className="secondary library-edit-content"
                      aria-label={`${item.title} 편집`}
                      disabled={loading}
                      onClick={() => void openContent(item, 'edit')}
                    >
                      편집
                    </button>
                    {tab === 'bot' && (onUseContent || onStartStory) && (
                      <button
                        type="button"
                        className="secondary library-start-chat"
                        disabled={loading}
                        aria-label={`${item.title} 새 채팅`}
                        onClick={() => void openContent(item, 'bot')}
                      >
                        새 채팅
                      </button>
                    )}
                  </article>
                ))}
                {filtered.length === 0 && (
                  <div className="library-empty">
                    <h2>{query ? '찾는 자료가 없어요' : '이곳에 자료를 모아 보세요'}</h2>
                    <p>
                      {query
                        ? '다른 이름이나 설명으로 찾아보세요.'
                        : `${contentLabels[tab]} 자료를 만들거나 다른 폴더에서 옮길 수 있어요.`}
                    </p>
                    {folder !== 'all' && (
                      <button type="button" className="secondary" onClick={() => setFolder('all')}>
                        이 탭 전체에서 찾기
                      </button>
                    )}
                    <button type="button" className="secondary" onClick={openNew}>
                      새로 만들기
                    </button>
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
      setSaved(item.title + ' · v' + item.revision + ' 저장됨');
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
        <h2>{selected ? selected.title : '새 자료'}</h2>
        <div className="library-detail-actions">
          {selected && (selected.kind === 'bot' || selected.package) && onStartStory && (
            <button
              type="button"
              className="secondary"
              disabled={busy || dirty || !!importedPackage || behaviorDraftDirty || portraitBusy}
              onClick={() => onStartStory(selected)}
            >
              {selected.kind === 'bot' ? '채팅 시작' : '이 자료를 봇으로 시작'}
            </button>
          )}
          {selected && (
            <DeleteButton
              path={`/content/${encodeURIComponent(selected.id)}`}
              revision={selected.revision}
              title={selected.title}
              label="자료 삭제"
              iconOnly
              disabled={busy}
              description="이 자료의 모든 저장 버전과 현재 편집 초안을 삭제해요. 되돌릴 수 없고, 다른 자료나 채팅에서 사용 중이면 삭제할 수 없어요."
              onError={onError}
              onDeleted={async () => {
                onDeleted();
                await reload();
              }}
            />
          )}
        </div>
      </div>
      <form
        className="editor-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          await saveContent();
        }}
      >
        <fieldset className="editor-fields full" disabled={busy}>
          {value.package && (
            <div className="full">
              <PackagePortraitEditor
                value={value.package}
                onChange={(pkg) => setValue((current) => ({ ...current, package: pkg }))}
                onDirtyChange={setPortraitBusy}
                disabled={busy}
              />
            </div>
          )}
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
            자료 이름
            <input
              aria-label="자료 이름"
              value={value.title}
              maxLength={160}
              required
              onChange={(event) => setValue({ ...value, title: event.target.value })}
            />
          </label>
          <label className="full">
            자료 설명
            <input
              aria-label="자료 설명"
              value={value.description}
              maxLength={1000}
              onChange={(event) => setValue({ ...value, description: event.target.value })}
            />
          </label>
          <label className="full">
            자료 본문
            <textarea
              aria-label="자료 본문"
              rows={10}
              value={value.text}
              maxLength={100000}
              required={!value.package}
              onChange={(event) => setValue({ ...value, text: event.target.value })}
            />
          </label>
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
          <label className="library-loading full">
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
          <button disabled={busy || !!importedPackage || behaviorDraftDirty || portraitBusy}>
            {busy ? '저장 중…' : selected ? '새 revision 저장' : '자료 등록'}
          </button>
          <span role="status">{saved}</span>
        </div>
        {selected && (
          <>
            <small className="full">서재에서 수정해도 기존 이야기에 장착된 버전은 유지돼요.</small>
            <details className="library-diagnostics full">
              <summary>자료 저장 정보</summary>
              <p>현재 버전 v{selected.revision}</p>
              <code>{selected.id}</code>
            </details>
          </>
        )}
      </form>
    </section>
  );
}

export { ConnectionEditor } from './ProviderSettings.js';
