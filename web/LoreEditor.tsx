import { SelectionCheckbox } from './BooleanControls.js';
import { useEffect, useRef, useState } from 'react';
import { useBufferedEditorState, useUnappliedEditorField } from './editor-workspace-context.js';
import { AddIcon, BackIcon, CloseIcon, FolderIcon, SearchIcon } from './ui-icons.js';
import type { ContentPackage, PackageLore } from '../core/content-package.js';
import { Dialog } from './Dialog.js';
import './lore-editor.css';
import './lore-context.css';

const PAGE_SIZE = 50;
export function LoreEditor({
  value,
  onChange,
  onDraftChange,
}: {
  value: ContentPackage;
  onChange: (part: Partial<ContentPackage>) => void;
  onDraftChange?: (dirty: boolean) => void;
}) {
  const folders = value.loreFolders ?? [];
  const [folder, setFolder] = useState('*');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState('*');
  const [selected, setSelected] = useState(value.lore[0]?.id ?? '');
  const [detailOpen, setDetailOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  function selectLore(id: string) {
    setSelected(id);
    setDetailOpen(true);
    requestAnimationFrame(() => {
      detailHeading.current?.focus({ preventScroll: true });
      if (matchMedia('(max-width: 760px)').matches)
        root.current
          ?.querySelector<HTMLElement>('.lore-detail')
          ?.scrollIntoView({ block: 'start' });
    });
  }
  const [checked, setChecked] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [folderEdit, setFolderEdit] = useBufferedEditorState<{ id?: string; name: string } | null>(
    'package.lore.folder-editor',
    null
  );
  const [deleteLore, setDeleteLore] = useState<string | null>(null);
  const [orderDrafts, setOrderDrafts] = useBufferedEditorState<Record<string, string>>(
    'package.lore.order',
    {}
  );
  const pendingOrders = value.lore.filter((row) => Object.hasOwn(orderDrafts, row.id));
  useUnappliedEditorField('package.lore.order', pendingOrders.length > 0);
  useEffect(() => {
    onDraftChange?.(pendingOrders.length > 0);
  }, [pendingOrders.length, onDraftChange]);
  const activeFolder = folders.find((item) => item.id === folder);
  const search = query.trim().toLocaleLowerCase();
  const filtered = value.lore.filter(
    (item) =>
      (folder === '*' || (item.folderId ?? '') === folder) &&
      (loading === '*' || item.loading === loading) &&
      (!search ||
        `${item.title}\n${item.description}\n${item.text}`.toLocaleLowerCase().includes(search))
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  // Editing a search match must never silently switch the input to another lore.
  const item = value.lore.find((item) => item.id === selected) ?? visible[0];
  const index = item ? value.lore.findIndex((row) => row.id === item.id) : -1;
  const resetList = () => {
    setPage(0);
    setChecked([]);
    setSelected('');
  };
  const changeItem = (patch: Partial<PackageLore>) => {
    if (!item) return;
    setSelected(item.id);
    onChange({ lore: value.lore.map((row) => (row.id === item.id ? { ...row, ...patch } : row)) });
  };
  const changeOrder = (text: string) => {
    if (!item) return;
    const order = text.trim() === '' ? undefined : Number(text);
    if (order !== undefined && (!Number.isSafeInteger(order) || Math.abs(order) > 1_000_000)) {
      setOrderDrafts((current) => ({ ...current, [item.id]: text }));
      return;
    }
    setOrderDrafts((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    changeItem({ loreContext: { placement: 'background', ...item.loreContext, order } });
  };
  const move = (ids: string[], target: string) => {
    onChange({
      lore: value.lore.map((row) => {
        if (!ids.includes(row.id)) return row;
        const { folderId: _, ...rest } = row;
        return target ? { ...rest, folderId: target } : rest;
      }),
    });
    setChecked([]);
  };
  const add = () => {
    const id = crypto.randomUUID();
    onChange({
      lore: [
        ...value.lore,
        {
          id,
          title: '새 로어',
          description: '',
          text: '',
          loading: 'discoverable',
          ...(activeFolder ? { folderId: activeFolder.id } : {}),
        },
      ],
    });
    setQuery('');
    setLoading('*');
    selectLore(id);
    setChecked([]);
    setPage(
      Math.floor(
        value.lore.filter((row) => folder === '*' || (row.folderId ?? '') === folder).length /
          PAGE_SIZE
      )
    );
  };
  return (
    <div
      className="lore-manager"
      data-detail={detailOpen && !!item}
      ref={root}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest('.lore-detail'))
          setDetailOpen(true);
      }}
    >
      <div className="lore-workspace">
        <section className="lore-list-pane" aria-label="로어 목록">
          <header className="lore-heading">
            <div>
              <strong>
                로어 <span className="muted">{value.lore.length}</span>
              </strong>
              <p className="muted">
                폴더는 편집용 분류예요. 포함 방식과 프롬프트 배치는 각 로어에서 정해요.
              </p>
            </div>
            <div className="lore-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setFolderEdit({ name: '' })}
              >
                <FolderIcon size={15} />
                폴더 추가
              </button>
              <button
                type="button"
                className="secondary"
                onClick={add}
                disabled={value.lore.length >= 2000}
              >
                <AddIcon size={15} />
                로어 추가
              </button>
            </div>
          </header>
          {pendingOrders.length > 0 && (
            <p className="error" role="status">
              순서 입력을 확인할 로어가 {pendingOrders.length}개 있어요.{' '}
              {pendingOrders.map((row) => (
                <button
                  type="button"
                  className="ghost"
                  key={row.id}
                  onClick={() => selectLore(row.id)}
                >
                  {row.title || '이름 없는 로어'}
                </button>
              ))}
            </p>
          )}
          <div className="lore-filters">
            <label className="lore-search">
              <SearchIcon size={16} />
              <input
                aria-label="로어 검색"
                placeholder="이름, 설명, 본문 검색"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  resetList();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault();
                }}
              />
            </label>
            <select
              aria-label="로어 폴더 필터"
              value={folder}
              onChange={(event) => {
                setFolder(event.target.value);
                resetList();
              }}
            >
              <option value="*">모든 폴더 · {value.lore.length}</option>
              <option value="">미분류 · {value.lore.filter((row) => !row.folderId).length}</option>
              {folders.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} · {value.lore.filter((row) => row.folderId === entry.id).length}
                </option>
              ))}
            </select>
            <select
              aria-label="로어 사용 방법 필터"
              value={loading}
              onChange={(event) => {
                setLoading(event.target.value);
                resetList();
              }}
            >
              <option value="*">모든 사용 방법</option>
              <option value="pinned">항상 포함</option>
              <option value="discoverable">필요할 때 읽기</option>
            </select>
          </div>
          {activeFolder && (
            <div className="lore-folder-bar">
              <span>
                <FolderIcon size={14} />
                {activeFolder.name}
              </span>
              <button
                type="button"
                className="ghost"
                onClick={() => setFolderEdit({ id: activeFolder.id, name: activeFolder.name })}
              >
                폴더 관리
              </button>
            </div>
          )}

          <div className="lore-list-summary">
            <label>
              <SelectionCheckbox
                aria-label="현재 페이지 로어 모두 선택"
                checked={visible.length > 0 && visible.every((row) => checked.includes(row.id))}
                onChange={(event) =>
                  setChecked(
                    event.target.checked
                      ? [...new Set([...checked, ...visible.map((row) => row.id)])]
                      : checked.filter((id) => !visible.some((row) => row.id === id))
                  )
                }
              />{' '}
              {filtered.length}개
            </label>
            <span>이름 / 사용 방법</span>
          </div>
          {checked.length > 0 && (
            <div className="lore-bulk">
              <span>{checked.length}개 선택</span>
              <select
                aria-label="선택한 로어 이동"
                value="__choose"
                onChange={(event) => move(checked, event.target.value)}
              >
                <option value="__choose" disabled>
                  폴더로 이동…
                </option>
                <option value="">미분류</option>
                {folders.map((entry) => (
                  <option value={entry.id} key={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              <button type="button" className="ghost" onClick={() => setChecked([])}>
                해제
              </button>
            </div>
          )}
          <div className="lore-rows">
            {visible.map((row) => (
              <div key={row.id} className={`lore-row ${item?.id === row.id ? 'selected' : ''}`}>
                <SelectionCheckbox
                  aria-label={`${row.title || '이름 없는 로어'} 선택`}
                  checked={checked.includes(row.id)}
                  onChange={(event) =>
                    setChecked(
                      event.target.checked
                        ? [...checked, row.id]
                        : checked.filter((id) => id !== row.id)
                    )
                  }
                />
                <button
                  type="button"
                  aria-pressed={item?.id === row.id}
                  data-lore-id={row.id}
                  onClick={() => selectLore(row.id)}
                >
                  <span className="lore-row-title">{row.title || '이름 없는 로어'}</span>
                  <span className="lore-row-meta">
                    {folders.find((entry) => entry.id === row.folderId)?.name ?? '미분류'} ·{' '}
                    {row.loading === 'pinned' ? '항상 포함' : '필요할 때'}
                  </span>
                </button>
              </div>
            ))}
            {!visible.length && (
              <p className="lore-empty muted">
                {value.lore.length
                  ? '조건에 맞는 로어가 없어요.'
                  : '로어를 추가해 세계와 인물을 기록해 보세요.'}
              </p>
            )}
          </div>
          {filtered.length > PAGE_SIZE && (
            <div className="lore-pagination">
              <button
                type="button"
                className="ghost"
                disabled={!currentPage}
                onClick={() => {
                  setPage(currentPage - 1);
                  setSelected('');
                }}
              >
                이전
              </button>
              <span>
                {currentPage + 1} / {Math.ceil(filtered.length / PAGE_SIZE)}
              </span>
              <button
                type="button"
                className="ghost"
                disabled={(currentPage + 1) * PAGE_SIZE >= filtered.length}
                onClick={() => {
                  setPage(currentPage + 1);
                  setSelected('');
                }}
              >
                다음
              </button>
            </div>
          )}
        </section>
        <section className="lore-detail" aria-label="선택한 로어 편집">
          <button
            type="button"
            className="secondary lore-list-back"
            onClick={() => {
              setDetailOpen(false);
              requestAnimationFrame(() => {
                const choice = root.current?.querySelector<HTMLButtonElement>(
                  `[data-lore-id="${CSS.escape(item?.id ?? '')}"]`
                );
                (
                  choice ??
                  root.current?.querySelector<HTMLInputElement>('[aria-label="로어 검색"]')
                )?.focus({ preventScroll: true });
              });
            }}
          >
            <BackIcon size={18} aria-hidden="true" /> 로어 목록
          </button>
          {item ? (
            <>
              <div className="lore-detail-heading">
                <h4 ref={detailHeading} tabIndex={-1}>
                  {item.title || '이름 없는 로어'}
                </h4>
                <button type="button" className="ghost" onClick={() => setDeleteLore(item.id)}>
                  로어 삭제
                </button>
              </div>
              <label>
                로어 이름
                <input
                  aria-label={`로어 ${index + 1} 이름`}
                  value={item.title}
                  maxLength={200}
                  onChange={(event) => changeItem({ title: event.target.value })}
                />
              </label>
              <div className="lore-detail-options">
                <label>
                  폴더
                  <select
                    aria-label="로어 소속 폴더"
                    value={item.folderId ?? ''}
                    onChange={(event) => move([item.id], event.target.value)}
                  >
                    <option value="">미분류</option>
                    {folders.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  포함 방식
                  <select
                    aria-label="사용 방법"
                    value={item.loading}
                    onChange={(event) =>
                      changeItem({ loading: event.target.value as PackageLore['loading'] })
                    }
                  >
                    <option value="discoverable">자동 · 모델이 필요할 때 읽기</option>
                    <option value="pinned">고정 · 항상 포함</option>
                  </select>
                </label>
              </div>

              <label>
                검색용 설명
                <input
                  value={item.description}
                  maxLength={4000}
                  onChange={(event) => changeItem({ description: event.target.value })}
                />
              </label>
              <label>
                로어 본문
                <textarea
                  aria-label={`로어 ${index + 1} 본문`}
                  rows={10}
                  maxLength={1_000_000}
                  value={item.text}
                  onChange={(event) => changeItem({ text: event.target.value })}
                />
              </label>
              {(item.loading === 'pinned' || Object.hasOwn(orderDrafts, item.id)) && (
                <fieldset className="lore-placement-fields">
                  <legend>고정 포함 때의 배치</legend>
                  <label>
                    배치
                    <select
                      aria-label={`로어 ${index + 1} 배치`}
                      value={item.loreContext?.placement ?? 'background'}
                      onChange={(event) =>
                        changeItem({
                          loreContext: {
                            ...item.loreContext,
                            placement: event.target.value as 'background' | 'scene',
                          },
                        })
                      }
                    >
                      <option value="background">배경 · 앞쪽의 공통 설정</option>
                      <option value="scene">장면 · 현재 요청 근처</option>
                    </select>
                  </label>
                  <div className="lore-placement-row">
                    <label>
                      배치 묶음
                      <input
                        aria-label={`로어 ${index + 1} 배치 묶음`}
                        maxLength={200}
                        value={item.loreContext?.group ?? ''}
                        onChange={(event) =>
                          changeItem({
                            loreContext: {
                              placement: 'background',
                              ...item.loreContext,
                              group: event.target.value || undefined,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      묶음 안 순서
                      <input
                        aria-label={`로어 ${index + 1} 배치 순서`}
                        inputMode="numeric"
                        placeholder="0"
                        value={
                          orderDrafts[item.id] ??
                          (item.loreContext?.order === undefined
                            ? ''
                            : String(item.loreContext.order))
                        }
                        onChange={(event) => changeOrder(event.target.value)}
                        aria-invalid={Object.hasOwn(orderDrafts, item.id)}
                      />
                    </label>
                  </div>
                  <small className="muted">
                    순서는 −1,000,000–1,000,000의 정수예요. 비우면 0으로 정렬해요.
                  </small>
                  {Object.hasOwn(orderDrafts, item.id) && (
                    <p className="error" role="alert">
                      정수 범위를 확인해 주세요. 입력한 초안은 유지돼요.
                    </p>
                  )}
                  <small className="muted">
                    자동 로어는 도구를 호출한 위치에서 읽어요. 다음 생성에 유지하는 구간은 처음 읽은
                    이력 위치에 놓아요. 위 배치는 고정 로어에 사용해요.
                  </small>
                  <small className="muted">
                    사용자가 만든 PromptProgram의 슬롯·역할·순서는 자동으로 바꾸지 않아요.
                  </small>
                </fieldset>
              )}
              <small className="muted">
                UTF-16 {item.text.length.toLocaleString()}자 · 자료를 저장하면 변경 사항이 함께
                저장돼요.
              </small>
            </>
          ) : (
            <p className="lore-empty muted">로어를 추가하거나 검색 조건을 바꿔 주세요.</p>
          )}
        </section>
      </div>
      <Dialog
        open={!!folderEdit}
        title={folderEdit?.id ? '로어 폴더 관리' : '로어 폴더 추가'}
        onClose={() => setFolderEdit(null)}
        className="lore-folder-dialog"
      >
        <label>
          폴더 이름
          <input
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
            value={folderEdit?.name ?? ''}
            maxLength={100}
            onChange={(event) =>
              setFolderEdit((current) =>
                current ? { ...current, name: event.target.value } : null
              )
            }
          />
        </label>
        <div className="lore-actions">
          <button
            type="button"
            disabled={!folderEdit?.name.trim() || (!folderEdit?.id && folders.length >= 2000)}
            onClick={() => {
              if (!folderEdit?.name.trim()) return;
              const id = folderEdit.id ?? crypto.randomUUID();
              onChange({
                loreFolders: folderEdit.id
                  ? folders.map((entry) =>
                      entry.id === id ? { ...entry, name: folderEdit.name.trim() } : entry
                    )
                  : [...folders, { id, name: folderEdit.name.trim() }],
              });
              setFolder(id);
              resetList();
              setFolderEdit(null);
            }}
          >
            {folderEdit?.id ? '이름 저장' : '폴더 만들기'}
          </button>
          <button type="button" className="secondary" onClick={() => setFolderEdit(null)}>
            <CloseIcon size={18} aria-hidden="true" />
            취소
          </button>
        </div>
        {folderEdit?.id && (
          <div className="lore-folder-delete">
            <p className="muted">폴더를 삭제하면 안의 로어는 미분류로 이동해요.</p>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                onChange({
                  loreFolders: folders.filter((entry) => entry.id !== folderEdit.id),
                  lore: value.lore.map((row) => {
                    if (row.folderId !== folderEdit.id) return row;
                    const { folderId: _, ...rest } = row;
                    return rest;
                  }),
                });
                setFolder('');
                resetList();
                setFolderEdit(null);
              }}
            >
              폴더 삭제 · 로어 유지
            </button>
          </div>
        )}
      </Dialog>
      <Dialog
        open={!!deleteLore}
        title="로어 삭제 확인"
        role="alertdialog"
        onClose={() => setDeleteLore(null)}
        className="lore-folder-dialog"
      >
        <p>‘{value.lore.find((row) => row.id === deleteLore)?.title}’ 로어를 초안에서 삭제해요.</p>
        <div className="lore-actions">
          <button type="button" className="secondary" onClick={() => setDeleteLore(null)}>
            <CloseIcon size={18} aria-hidden="true" />
            취소
          </button>
          <button
            type="button"
            onClick={() => {
              onChange({
                lore: value.lore
                  .filter((row) => row.id !== deleteLore)
                  .map((row) => ({
                    ...row,
                    relatedIds: row.relatedIds?.filter((id) => id !== deleteLore),
                  })),
              });
              setChecked(checked.filter((id) => id !== deleteLore));
              setDeleteLore(null);
            }}
          >
            삭제
          </button>
        </div>
      </Dialog>
    </div>
  );
}
