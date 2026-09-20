import { useState, type ReactNode } from 'react';
import { Switch } from './BooleanControls.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import {
  AddIcon,
  FolderAddIcon,
  FolderIcon,
  ExpandIcon,
  DropdownIcon,
  DeleteIcon,
  UpIcon,
  DownIcon,
  ListIcon,
} from './ui-icons.js';
import {
  isLoreFolder,
  loreFolderKey,
  loreParents,
  loreText,
  loreTitle,
  newLoreEntry,
  removeLoreFolder,
  type LoreEntry,
} from './native-lore-document.js';
import './native-risu-lore.css';

function Keywords({
  value,
  onChange,
  label,
}: {
  value: unknown;
  onChange: (value: string[]) => void;
  label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      aria-label={label}
      value={draft ?? (Array.isArray(value) ? value.join(', ') : '')}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(
          event.target.value
            .split(',')
            .map((key) => key.trim())
            .filter(Boolean)
        );
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

export function NativeRisuLoreEditor({
  entries,
  moduleLore,
  onChange,
  selectionControl,
}: {
  entries: LoreEntry[];
  moduleLore: boolean;
  onChange: (entries: LoreEntry[]) => void;
  selectionControl: ReactNode;
}) {
  const [selected, setSelected] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [showList, setShowList] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const index = Math.min(selected, Math.max(0, entries.length - 1));
  const entry = entries[index];
  const parents = loreParents(entries);
  const folders = entries.map((item, i) => ({ item, i })).filter(({ item }) => isLoreFolder(item));
  const folder = !!entry && isLoreFolder(entry);
  const title = entry ? loreTitle(entry) : '로어북';
  const needle = query.trim().toLocaleLowerCase();
  const matches = entries.map((item) =>
    `${loreTitle(item)} ${loreText(item.content)} ${loreFolderKey(item)}`
      .toLocaleLowerCase()
      .includes(needle)
  );
  const visible = new Set<number>();
  matches.forEach((match, i) => {
    if (!match) return;
    visible.add(i);
    let parent = parents[i];
    while (parent !== null) {
      visible.add(parent);
      parent = parents[parent];
    }
  });
  const select = (i: number) => {
    setSelected(i);
    setShowList(false);
  };
  const edit = (patch: LoreEntry) =>
    onChange(entries.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  const add = (isFolder: boolean) => {
    const next = newLoreEntry(entries, moduleLore, isFolder);
    if (!isFolder && entry) {
      const parent = folder ? loreFolderKey(entry) : loreText(entry.folder);
      if (parent) next.folder = parent;
    }
    onChange([...entries, next]);
    setSelected(entries.length);
    setQuery('');
    setShowList(false);
    if (next.folder)
      setCollapsed((previous) => {
        const result = new Set(previous);
        result.delete(loreText(next.folder));
        return result;
      });
  };
  const siblings = entries.map((_, i) => i).filter((i) => parents[i] === parents[index]);
  const position = siblings.indexOf(index);
  const move = (delta: number) => {
    const destination = siblings[position + delta];
    if (destination === undefined) return;
    const next = [...entries];
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next);
    setSelected(destination);
  };
  const canParent = (i: number) => {
    let cursor: number | null = i;
    while (cursor !== null) {
      if (cursor === index) return false;
      cursor = parents[cursor];
    }
    return true;
  };
  const row = (i: number, depth: number): ReactNode => {
    if (!visible.has(i)) return null;
    const item = entries[i],
      isFolder = isLoreFolder(item),
      key = loreFolderKey(item);
    const closed = collapsed.has(key) && !needle;
    return (
      <div key={i} className="nl-tree-node">
        <div
          className={`nl-row${index === i ? ' is-selected' : ''}`}
          style={{ paddingLeft: Math.min(depth, 5) * 14 }}
        >
          {isFolder && (
            <IconButton
              label={`${loreTitle(item)} ${closed ? '펼치기' : '접기'}`}
              icon={closed ? ExpandIcon : DropdownIcon}
              aria-expanded={!closed}
              onClick={() =>
                setCollapsed((old) => {
                  const next = new Set(old);
                  if (closed) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
            />
          )}
          <button
            type="button"
            className="nl-select"
            aria-label={loreTitle(item)}
            aria-current={index === i ? 'true' : undefined}
            onClick={() => select(i)}
          >
            <strong>
              {isFolder && <FolderIcon size={16} aria-hidden="true" />}
              {loreTitle(item)}
            </strong>
            <small>
              {isFolder
                ? `${parents.filter((parent, child) => parent === i && !isLoreFolder(entries[child])).length}개 로어`
                : item.enabled === false
                  ? '사용 안 함'
                  : (moduleLore ? item.alwaysActive : item.constant)
                    ? '항상 포함'
                    : '필요할 때'}
            </small>
          </button>
        </div>
        {isFolder &&
          !closed &&
          entries.map((_, child) => (parents[child] === i ? row(child, depth + 1) : null))}
      </div>
    );
  };
  return (
    <div className={`native-editor-split native-lore-editor${showList ? ' nl-show-list' : ''}`}>
      <button
        type="button"
        className="secondary nl-mobile-list"
        aria-expanded={showList}
        onClick={() => setShowList((current) => !current)}
      >
        <ListIcon size={18} />
        {showList ? '로어 목록 닫기' : '로어 목록 보기'}
      </button>
      <aside className="native-item-list nl-list" aria-label="로어 목록">
        <input
          type="search"
          aria-label="로어 찾기"
          placeholder="이름·본문으로 찾기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="native-list-heading">
          <strong>로어북 · {entries.filter((item) => !isLoreFolder(item)).length}</strong>
          <IconButton label="폴더 추가" icon={FolderAddIcon} onClick={() => add(true)} />
          <IconButton label="로어 추가" icon={AddIcon} onClick={() => add(false)} />
        </div>
        <div className="nl-tree">
          {entries.map((_, i) => (parents[i] === null ? row(i, 0) : null))}
          {!visible.size && (
            <p className="muted">
              {entries.length ? '검색 결과가 없어요.' : '아직 로어가 없어요.'}
            </p>
          )}
        </div>
        <details className="nl-policy">
          <summary>로어 선택 설정</summary>
          {selectionControl}
        </details>
      </aside>
      <div className="native-item-detail nl-detail">
        {entry ? (
          <>
            <div className="native-detail-heading">
              <h3>
                {folder && <FolderIcon size={20} aria-hidden="true" />} {title}
              </h3>
              <IconButton
                label={folder ? '폴더 위로' : '로어 위로'}
                icon={UpIcon}
                disabled={position <= 0}
                onClick={() => move(-1)}
              />
              <IconButton
                label={folder ? '폴더 아래로' : '로어 아래로'}
                icon={DownIcon}
                disabled={position === siblings.length - 1}
                onClick={() => move(1)}
              />
              <IconButton
                label={folder ? '폴더 삭제' : '선택한 로어 삭제'}
                icon={DeleteIcon}
                onClick={() => setDeleting(index)}
              />
            </div>
            <div className="nl-fields">
              <label>
                {folder ? '폴더 이름' : '항목 이름'}
                <input
                  aria-label={folder ? '폴더 이름' : '로어 이름'}
                  value={loreText(entry.comment ?? entry.name)}
                  onChange={(e) =>
                    edit(
                      moduleLore
                        ? { comment: e.target.value }
                        : {
                            name: e.target.value,
                            ...(Object.hasOwn(entry, 'comment') ? { comment: e.target.value } : {}),
                          }
                    )
                  }
                />
              </label>
              {!folder && (
                <label>
                  포함 방식
                  <select
                    aria-label="포함 방식"
                    value={
                      entry.enabled === false
                        ? 'none'
                        : (moduleLore ? entry.alwaysActive : entry.constant)
                          ? 'always'
                          : 'conditional'
                    }
                    onChange={(e) =>
                      edit({
                        enabled: e.target.value !== 'none',
                        ...(e.target.value === 'none'
                          ? {}
                          : {
                              [moduleLore ? 'alwaysActive' : 'constant']:
                                e.target.value === 'always',
                            }),
                      })
                    }
                  >
                    <option value="none">미포함</option>
                    <option value="conditional">필요할 때 · 관련성 판단</option>
                    <option value="always">항상 포함</option>
                  </select>
                </label>
              )}
            </div>
            <label>
              폴더
              <select
                aria-label="로어 폴더"
                value={loreText(entry.folder)}
                onChange={(e) => {
                  const next = { ...entry };
                  if (e.target.value) next.folder = e.target.value;
                  else delete next.folder;
                  onChange(entries.map((item, i) => (i === index ? next : item)));
                }}
              >
                <option value="">미분류</option>
                {!!entry.folder &&
                  !folders.some(({ item }) => loreFolderKey(item) === entry.folder) && (
                    <option value={loreText(entry.folder)}>원본 폴더 · 찾을 수 없음</option>
                  )}
                {folders
                  .filter(({ i }) => canParent(i))
                  .map(({ item, i }) => (
                    <option key={i} value={loreFolderKey(item)}>
                      {loreTitle(item)}
                    </option>
                  ))}
              </select>
            </label>
            {folder ? (
              <div className="nl-folder-content">
                <p className="muted">
                  폴더로 로어를 묶어 관리해요. 포함 방식은 각 로어에서 설정해요.
                </p>
                <button type="button" className="secondary" onClick={() => add(false)}>
                  <AddIcon size={16} />이 폴더에 로어 추가
                </button>
                <div className="nl-folder-children">
                  {entries.map((child, i) =>
                    parents[i] === index ? (
                      <button type="button" key={i} onClick={() => select(i)}>
                        {isLoreFolder(child) && <FolderIcon size={16} />}
                        {loreTitle(child)}
                      </button>
                    ) : null
                  )}
                </div>
              </div>
            ) : (
              <>
                <label>
                  로어 본문
                  <textarea
                    className="native-main-text"
                    aria-label="로어 본문"
                    rows={16}
                    value={loreText(entry.content)}
                    onChange={(e) => edit({ content: e.target.value })}
                  />
                </label>
                <label className="check nl-switch">
                  사용
                  <Switch
                    aria-label="로어 사용"
                    checked={entry.enabled !== false}
                    onChange={(e) => edit({ enabled: e.target.checked })}
                  />
                </label>
                <details className="native-advanced nl-advanced" key={index}>
                  <summary>조건·배치·원문 설정</summary>
                  <label>
                    키워드
                    {moduleLore ? (
                      <input
                        aria-label="로어 키워드"
                        value={loreText(entry.key)}
                        onChange={(e) => edit({ key: e.target.value })}
                      />
                    ) : (
                      <Keywords
                        key={index}
                        label="로어 키워드"
                        value={entry.keys}
                        onChange={(keys) => edit({ keys })}
                      />
                    )}
                  </label>
                  <label className="check nl-switch">
                    보조 키워드 사용
                    <Switch
                      checked={entry.selective === true}
                      onChange={(e) =>
                        edit({
                          selective: e.target.checked,
                          ...(moduleLore && e.target.checked && typeof entry.secondkey !== 'string'
                            ? { secondkey: '' }
                            : {}),
                        })
                      }
                    />
                  </label>
                  {entry.selective === true && (
                    <label>
                      보조 키워드
                      {moduleLore ? (
                        <input
                          aria-label="보조 키워드"
                          value={loreText(entry.secondkey)}
                          onChange={(e) => edit({ secondkey: e.target.value })}
                        />
                      ) : (
                        <Keywords
                          key={index}
                          label="보조 키워드"
                          value={entry.secondary_keys}
                          onChange={(keys) => edit({ secondary_keys: keys })}
                        />
                      )}
                    </label>
                  )}
                  <label className="check nl-switch">
                    정규식 키워드
                    <Switch
                      checked={(moduleLore ? entry.useRegex : entry.use_regex) === true}
                      onChange={(e) =>
                        edit({ [moduleLore ? 'useRegex' : 'use_regex']: e.target.checked })
                      }
                    />
                  </label>
                  <label>
                    삽입 순서
                    <input
                      aria-label="로어 삽입 순서"
                      type="number"
                      value={Number(entry.insertorder ?? entry.insertion_order ?? 100)}
                      onChange={(e) =>
                        edit({
                          [moduleLore ? 'insertorder' : 'insertion_order']: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <p className="muted">CBS 조건과 나머지 원문 필드는 그대로 유지돼요.</p>
                </details>
              </>
            )}
          </>
        ) : (
          <div className="native-empty">
            <p>로어북에 첫 항목을 추가해 보세요.</p>
            <button type="button" onClick={() => add(false)}>
              로어 추가
            </button>
            <button type="button" className="secondary" onClick={() => add(true)}>
              폴더 추가
            </button>
          </div>
        )}
      </div>
      <Dialog
        open={deleting !== null}
        title={deleting !== null && isLoreFolder(entries[deleting]) ? '폴더 삭제' : '로어 삭제'}
        onClose={() => setDeleting(null)}
      >
        <p>
          {deleting !== null && isLoreFolder(entries[deleting])
            ? '폴더만 삭제하고 안의 로어는 상위 폴더로 옮겨요.'
            : '선택한 로어를 삭제할까요?'}
        </p>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => setDeleting(null)}>
            취소
          </button>
          <button
            type="button"
            onClick={() => {
              if (deleting === null) return;
              onChange(
                isLoreFolder(entries[deleting])
                  ? removeLoreFolder(entries, deleting)
                  : entries.filter((_, i) => i !== deleting)
              );
              setSelected(Math.max(0, deleting - 1));
              setDeleting(null);
            }}
          >
            {deleting !== null && isLoreFolder(entries[deleting]) ? '폴더만 삭제' : '로어 삭제'}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
