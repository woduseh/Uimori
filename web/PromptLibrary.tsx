import { SelectionCheckbox } from './BooleanControls.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AddIcon, EditIcon, MoveIcon, CopyIcon, SettingsIcon } from './ui-icons.js';
import type { Library, PromptPreset, PromptRole } from '../core/product.js';
import type { LibraryItemKey, LibraryOrganization } from '../core/library-organization.js';
import { libraryFolderOf } from '../core/library-organization.js';
import { api } from './api.js';
import { Dialog } from './Dialog.js';
import { DeleteButton } from './DeleteButton.js';
import { PromptEditor } from './PromptEditor.js';
import { discardActiveEditor } from './editor-workspace-context.js';
import { SlidersHorizontal } from 'lucide-react';
import {
  LibraryFolders,
  LibraryItemMenu,
  LibraryMoveDialog,
  useLibraryOrganization,
  type FolderFilter,
} from './LibraryFolders.js';
import './library.css';

export function PromptLibrary({
  library,
  reload,
  onError,
  onDirtyChange,
  headerLeading,
  onOpenCurrentPrompts,
  initialPresetId,
  onInitialPresetHandled,
}: {
  library: Library | null;
  reload: () => Promise<void>;
  onError: (message: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  headerLeading?: ReactNode;
  onOpenCurrentPrompts: () => void;
  initialPresetId?: string | null;
  onInitialPresetHandled?: () => void;
}) {
  const [folder, setFolder] = useState<FolderFilter>('all');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'all' | PromptRole>('all');
  const [sort, setSort] = useState('name');
  const [editing, setEditing] = useState<{ preset: PromptPreset | null; role: PromptRole } | null>(
    null
  );
  const pendingEditing = useRef<typeof editing>(null);
  const handledPreset = useRef<string | null>(null);
  useEffect(() => {
    if (!initialPresetId) {
      handledPreset.current = null;
      return;
    }
    if (!library || handledPreset.current === initialPresetId) return;
    handledPreset.current = initialPresetId;
    const preset = library.promptPresets?.find((item) => item.id === initialPresetId);
    if (preset) setEditing({ preset, role: preset.role });
    else onError('선택한 프롬프트를 찾을 수 없어요.');
    onInitialPresetHandled?.();
  }, [initialPresetId, library, onError, onInitialPresetHandled]);

  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [moving, setMoving] = useState<LibraryItemKey[] | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const organizer = useLibraryOrganization(library, reload, onError);
  const mutation = useRef(false);
  const [busy, setBusy] = useState(false);
  const organized = library
    ? { ...library, organization: organizer.organization ?? library.organization }
    : null;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
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
    .sort((a, b) => (sort === 'name-desc' ? -1 : 1) * a.title.localeCompare(b.title, 'ko'));
  function changeEditing(next: typeof editing) {
    pendingEditing.current = next;
    if (dirty) setDiscard(true);
    else setEditing(next);
  }
  function close() {
    changeEditing(null);
  }
  async function placeCreated(preset: PromptPreset, created: boolean) {
    if (!created || folder === 'all' || folder === 'unclassified') return;
    const current = await api<LibraryOrganization>('/library/organization');
    await organizer.mutate(
      '/library/organization/move',
      { items: [{ kind: 'prompt-preset', id: preset.id }], category: 'prompts', folderId: folder },
      'POST',
      current.revision
    );
  }
  async function clone(item: PromptPreset) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    try {
      const full = await api<PromptPreset>(`/prompt-presets/${item.id}`);
      const copy = await api<PromptPreset>('/prompt-presets', {
        title: `${full.title} 사본`,
        role: full.role,
        program: full.program,
        values: full.values,
      });
      await placeCreated(copy, true);
      await reload();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className="library-page prompt-library"
      aria-label="프롬프트 관리"
      data-testid="prompt-library"
    >
      <header className="library-heading">
        {headerLeading}
        <h1>프롬프트</h1>
        {!editing && (!library || filtered.length > 0 || !!query) && (
          <button
            type="button"
            className="library-create"
            disabled={!library}
            onClick={() =>
              changeEditing({ preset: null, role: role === 'translation' ? role : 'main' })
            }
          >
            <AddIcon size={18} aria-hidden="true" /> 새 프롬프트
          </button>
        )}
      </header>
      {library && !editing && (
        <button
          type="button"
          className="secondary prompt-settings-link"
          onClick={onOpenCurrentPrompts}
        >
          <SettingsIcon size={18} aria-hidden="true" />
          현재 프롬프트 설정
        </button>
      )}
      <Dialog
        open={discard}
        title="미저장 프롬프트 확인"
        role="alertdialog"
        className="library-discard-dialog"
        onClose={() => setDiscard(false)}
      >
        <p>저장하지 않은 프롬프트 편집 내용이 있어요.</p>
        <div className="library-discard-actions">
          <button type="button" className="secondary" onClick={() => setDiscard(false)}>
            계속 편집
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await discardActiveEditor();
                setDiscard(false);
                setDirty(false);
                setEditing(pendingEditing.current);
              } catch (error) {
                onError((error as Error).message);
              }
            }}
          >
            초안 버리고 이동
          </button>
        </div>
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
        <p role="status">프롬프트를 불러오는 중이에요…</p>
      ) : editing ? (
        <div className="library-prompt-editor">
          <div className="library-detail-heading">
            <button type="button" className="secondary" onClick={close}>
              ← 프롬프트 목록
            </button>
            <h2>{editing.preset?.title ?? '새 프롬프트'}</h2>
          </div>
          <PromptEditor
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
              <LibraryFolders
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
              <label className="library-search-field">
                <span className="sr-only">프롬프트 검색</span>
                <input
                  type="search"
                  aria-label="프롬프트 검색"
                  placeholder="이름으로 찾기"
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
                    역할
                    <select
                      aria-label="프롬프트 역할 필터"
                      value={role}
                      onChange={(event) => setRole(event.target.value as typeof role)}
                    >
                      <option value="all">모든 역할</option>
                      <option value="main">작문</option>
                      <option value="translation">번역</option>
                    </select>
                  </label>
                  <label>
                    정렬
                    <select
                      aria-label="프롬프트 정렬"
                      value={sort}
                      onChange={(event) => setSort(event.target.value)}
                    >
                      <option value="name">이름순</option>
                      <option value="name-desc">이름 역순</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="secondary"
                    aria-pressed={selecting}
                    onClick={() => {
                      setSelecting(!selecting);
                      setSelection([]);
                    }}
                  >
                    선택
                  </button>
                </div>
              </LibraryItemMenu>
            </div>
            {!!query && (
              <p className="library-result-count muted" role="status">
                검색 결과 {filtered.length}개
              </p>
            )}
            {selecting && (
              <div className="library-bulk-toolbar">
                <span>{selection.length}개 선택</span>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setSelection(filtered.map((item) => item.id))}
                >
                  표시된 자료 전체 선택
                </button>
                <button
                  type="button"
                  disabled={!selection.length || organizer.busy}
                  onClick={() => setMoving(selection.map((id) => ({ kind: 'prompt-preset', id })))}
                >
                  선택한 자료 이동
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setSelecting(false);
                    setSelection([]);
                  }}
                >
                  선택 취소
                </button>
              </div>
            )}
            <div className="library-list">
              {filtered.map((item) => (
                <article className="library-list-item" key={item.id}>
                  {selecting && (
                    <label className="library-select-check">
                      <span className="sr-only">{item.title} 선택</span>
                      <SelectionCheckbox
                        aria-label={`${item.title} 선택`}
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
                    aria-label={`${item.title} 프롬프트 편집`}
                    onClick={() => changeEditing({ preset: item, role: item.role })}
                  >
                    <span className="library-prompt-icon" aria-hidden="true">
                      ≡
                    </span>
                    <span className="library-item-copy">
                      <strong>{item.title}</strong>
                      <span>{item.role === 'main' ? '작문' : '번역'} 프롬프트</span>
                    </span>
                  </button>
                  <LibraryItemMenu title={`${item.title} 메뉴`}>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => changeEditing({ preset: item, role: item.role })}
                    >
                      <EditIcon size={18} aria-hidden="true" /> 편집
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={organizer.busy}
                      onClick={() => setMoving([{ kind: 'prompt-preset', id: item.id }])}
                    >
                      <MoveIcon size={18} aria-hidden="true" /> 폴더 이동
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void clone(item)}
                    >
                      <CopyIcon size={18} aria-hidden="true" /> 복제
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
                <h2>{query ? '찾는 프롬프트가 없어요' : '아직 프롬프트가 없어요'}</h2>
                <p>작문과 번역에 사용할 지침을 만들어 보세요.</p>
                {folder !== 'all' && (
                  <button type="button" className="secondary" onClick={() => setFolder('all')}>
                    전체에서 찾기
                  </button>
                )}
                <button
                  type="button"
                  className="library-create"
                  onClick={() =>
                    changeEditing({ preset: null, role: role === 'translation' ? role : 'main' })
                  }
                >
                  새 프롬프트
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
