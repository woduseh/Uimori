import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
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
import { EditIcon, FolderAddIcon, FolderIcon, MoreIcon } from './ui-icons.js';
import './library-folders.css';

export const categoryLabels: Record<LibraryCategory, string> = {
  bot: '봇',
  persona: '페르소나',
  module: '모듈',
  prompts: '프롬프트',
};
export type FolderFilter = 'all' | 'unclassified' | string;

export function useLibraryOrganization(
  library: Library | null,
  reload: () => Promise<void>,
  onError: (error: string) => void
) {
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
        onError(`변경은 저장됐어요. 목록을 다시 불러오지 못했어요. ${(error as Error).message}`);
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
export type LibraryOrganizer = ReturnType<typeof useLibraryOrganization>;

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
  reload,
  onError,
  compactMobile = false,
}: {
  category: LibraryCategory;
  organizer: LibraryOrganizer;
  value: FolderFilter;
  onChange: (value: FolderFilter) => void;
  counts: Record<string, number>;
  reload: () => Promise<void>;
  onError: (error: string) => void;
  compactMobile?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [edit, setEdit] = useState<{ folder: LibraryFolder | null; revision: number } | null>(null);
  const [title, setTitle] = useState('');
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
  const options = [
    { id: 'all', title: '전체' },
    { id: 'unclassified', title: '미분류' },
    ...folders,
  ];
  function folderActions(folder: LibraryFolder) {
    const index = folders.findIndex((item) => item.id === folder.id);
    return (
      <>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => openEdit(folder)}
        >
          <EditIcon size={18} aria-hidden="true" />
          이름 변경
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || index === 0}
          onClick={() =>
            void mutate(
              `/library/folders/${encodeURIComponent(folder.id)}`,
              { beforeFolderId: folders[index - 1]?.id },
              'PATCH'
            )
          }
        >
          <ArrowUp size={18} aria-hidden="true" />
          위로
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || index === folders.length - 1}
          onClick={() =>
            void mutate(
              `/library/folders/${encodeURIComponent(folder.id)}`,
              { beforeFolderId: folders[index + 2]?.id ?? null },
              'PATCH'
            )
          }
        >
          <ArrowDown size={18} aria-hidden="true" />
          아래로
        </button>
        <DeleteButton
          path={`/library/folders/${encodeURIComponent(folder.id)}`}
          revision={organization?.revision}
          title={folder.title}
          label="폴더 삭제"
          description="폴더 안의 자료는 삭제하지 않고 이 분류의 미분류로 옮겨요."
          disabled={busy}
          onError={(message) => {
            onError(message);
            void reload();
          }}
          onDeleted={reload}
        />
      </>
    );
  }
  const selectedFolder = folders.find((item) => item.id === value);
  return (
    <aside
      className={`library-folders ${collapsed ? 'is-collapsed' : ''} ${compactMobile ? 'library-folders-compact' : ''}`}
      aria-label={`${categoryLabels[category]} 폴더`}
    >
      <div className="library-folders-heading">
        <button
          type="button"
          className="secondary library-folder-collapse"
          aria-label={collapsed ? '폴더 펼치기' : '폴더 접기'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
        {!collapsed && <strong>폴더</strong>}
        <button
          type="button"
          className="secondary"
          aria-label="새 폴더"
          disabled={busy || !organization}
          onClick={() => openEdit(null)}
        >
          <FolderAddIcon size={20} aria-hidden="true" />
          <span className={compactMobile ? 'sr-only' : undefined}>새 폴더</span>
        </button>
      </div>
      <label className="library-folder-mobile">
        <span className="sr-only">폴더 선택</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((item) => (
            <option value={item.id} key={item.id}>
              {item.title} ({counts[item.id] ?? 0})
            </option>
          ))}
        </select>
      </label>
      {compactMobile && (
        <div className="library-mobile-folder-actions">
          <LibraryItemMenu title="폴더 관리">
            <button
              type="button"
              className="secondary"
              disabled={busy || !organization}
              onClick={() => openEdit(null)}
            >
              <FolderAddIcon size={18} aria-hidden="true" />새 폴더
            </button>
            {selectedFolder && folderActions(selectedFolder)}
          </LibraryItemMenu>
        </div>
      )}
      {
        <div className="library-folder-list">
          {options.map((item) => {
            const index = folders.findIndex((folder) => folder.id === item.id);
            const folder = folders[index];
            return (
              <div className="library-folder-row" key={item.id}>
                <button
                  type="button"
                  className="secondary library-folder-choice"
                  aria-pressed={value === item.id}
                  onClick={() => onChange(item.id)}
                  title={item.title}
                >
                  <FolderIcon size={18} aria-hidden="true" />
                  <span>{item.title}</span>
                  <small>{counts[item.id] ?? 0}</small>
                </button>
                {folder && (
                  <LibraryItemMenu title={`${folder.title} 폴더 메뉴`}>
                    {folderActions(folder)}
                  </LibraryItemMenu>
                )}
              </div>
            );
          })}
        </div>
      }
      <Dialog
        open={!!edit}
        title={edit?.folder ? '폴더 이름 변경' : '새 폴더'}
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
            폴더 이름
            <input
              aria-label="폴더 이름"
              value={title}
              required
              maxLength={160}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {edit && organization && edit.revision !== organization.revision && (
            <div className="library-folder-review" role="status">
              <p>다른 변경이 반영됐어요. 최신 폴더 상태를 확인하고 다시 저장해 주세요.</p>
              {edit.folder && (
                <p>
                  현재 이름:{' '}
                  {organization.folders.find((item) => item.id === edit.folder?.id)?.title ??
                    '삭제된 폴더'}
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
                최신 상태 확인
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
              취소
            </button>
            <button disabled={busy || !title.trim() || edit?.revision !== organization?.revision}>
              {edit?.folder ? '이름 저장' : '폴더 만들기'}
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
      title="자료 이동"
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
        <p>{items?.length ?? 0}개 자료를 옮겨요. 기존 채팅과 자료 내용은 유지돼요.</p>
        <label>
          분류
          <select
            aria-label="이동할 분류"
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
                {categoryLabels[item]}
              </option>
            ))}
          </select>
        </label>
        <label>
          폴더
          <select
            aria-label="이동할 폴더"
            value={folderId}
            disabled={busy}
            onChange={(event) => setFolderId(event.target.value)}
          >
            <option value="">미분류</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.title}
              </option>
            ))}
            {stale && <option value={folderId}>삭제된 폴더</option>}
          </select>
        </label>
        {stale && <p role="alert">목적지 폴더가 삭제됐어요. 다른 폴더를 선택해 주세요.</p>}
        {organization && revision !== organization.revision && (
          <div className="library-folder-review" role="status">
            <p>서재가 변경됐어요. 현재 분류와 목적지 폴더를 확인해 주세요.</p>
            <button
              type="button"
              className="secondary"
              disabled={busy || stale}
              onClick={() => setRevision(organization.revision)}
            >
              최신 상태 확인
            </button>
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button
            disabled={
              busy || stale || revision === undefined || revision !== organization?.revision
            }
          >
            이동
          </button>
        </div>
      </form>
    </Dialog>
  );
}
