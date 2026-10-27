import { useI18n } from './i18n.js';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
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
  CloseIcon,
  UpIcon,
  DownIcon,
  ListIcon,
  DragHandleIcon,
} from './ui-icons.js';
import {
  isLoreFolder,
  loreFolderKey,
  loreParents,
  loreText,
  moveLoreEntry,
  newLoreEntry,
  removeLoreFolder,
  type LoreEntry,
  type LoreDropPosition,
} from './native-lore-document.js';
import './native-risu-lore.css';
import './deletion.css';

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
  const { t } = useI18n();
  const loreTitle = (entry: LoreEntry) =>
    loreText(entry.comment ?? entry.name) || t('native.unnamedLore');

  const [selected, setSelected] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [showList, setShowList] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const draggedRef = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    index: number | null;
    position: LoreDropPosition;
  } | null>(null);
  const dropTargetRef = useRef<{
    index: number | null;
    position: LoreDropPosition;
  } | null>(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState<{
    title: string;
    destination: string;
  } | null>(null);
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandKey = useRef('');
  const index = Math.min(selected, Math.max(0, entries.length - 1));
  const entry = entries[index];
  const parents = loreParents(entries);
  const folders = entries.map((item, i) => ({ item, i })).filter(({ item }) => isLoreFolder(item));
  const folder = !!entry && isLoreFolder(entry);
  const title = entry ? loreTitle(entry) : t('native.text_5ce4911d95');
  const needle = query.trim().toLocaleLowerCase();
  const matches = entries.map(
    (item) =>
      !needle ||
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
  useEffect(
    () => () => {
      if (expandTimer.current) clearTimeout(expandTimer.current);
    },
    []
  );
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
  const clearDrag = () => {
    draggedRef.current = null;
    setDragged(null);
    dropTargetRef.current = null;
    setDropTarget(null);
    cancelExpand();
  };
  const cancelExpand = () => {
    if (expandTimer.current) clearTimeout(expandTimer.current);
    expandTimer.current = null;
    expandKey.current = '';
  };
  const targetFor = (event: DragEvent<HTMLElement>, targetIndex: number) => {
    const target = entries[targetIndex];
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - bounds.top) / Math.max(1, bounds.height);
    const position: LoreDropPosition =
      isLoreFolder(target) && ratio >= 0.25 && ratio <= 0.75
        ? 'inside'
        : ratio < 0.5
          ? 'before'
          : 'after';
    return { index: targetIndex, position };
  };
  const over = (event: DragEvent<HTMLElement>, targetIndex: number) => {
    const sourceIndex = draggedRef.current;
    if (sourceIndex === null) return;
    const target = targetFor(event, targetIndex);
    if (!moveLoreEntry(entries, sourceIndex, target.index, target.position)) {
      dropTargetRef.current = null;
      setDropTarget(null);
      cancelExpand();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    dropTargetRef.current = target;
    setDropTarget(target);
    const targetEntry = entries[targetIndex];
    const key = target.position === 'inside' ? loreFolderKey(targetEntry) : '';
    if (!needle && key && collapsed.has(key) && expandKey.current !== key) {
      if (expandTimer.current) clearTimeout(expandTimer.current);
      expandKey.current = key;
      expandTimer.current = setTimeout(() => {
        setCollapsed((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }, 650);
    } else if (!key || needle || !collapsed.has(key)) cancelExpand();
    const list = event.currentTarget.closest('.nl-list');
    if (list) {
      const listBounds = list.getBoundingClientRect();
      if (event.clientY < listBounds.top + 36) list.scrollTop -= 12;
      if (event.clientY > listBounds.bottom - 36) list.scrollTop += 12;
    }
  };
  const commitDrop = (
    event: DragEvent<HTMLElement>,
    target: { index: number | null; position: LoreDropPosition }
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const sourceIndex = draggedRef.current;
    const sourceTitle = sourceIndex === null ? '' : loreTitle(entries[sourceIndex]);
    const result =
      sourceIndex === null
        ? null
        : moveLoreEntry(entries, sourceIndex, target.index, target.position);
    clearDrag();
    if (!result) return;
    onChange(result.entries);
    setSelected(result.index);
    const destination =
      target.position === 'root' || target.index === null
        ? t('native.text_93e97c7cec')
        : target.position === 'inside'
          ? t('native.folderDestination', { name: loreTitle(entries[target.index]) })
          : loreTitle(entries[target.index]);
    setMoveAnnouncement({ title: sourceTitle, destination });
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
          data-dragging={dragged === i ? 'true' : undefined}
          data-drop-position={dropTarget?.index === i ? dropTarget.position : undefined}
          draggable
          onDragStart={(event) => {
            if ((event.target as HTMLElement).closest('.icon-button')) {
              event.preventDefault();
              return;
            }
            setSelected(i);
            draggedRef.current = i;
            setDragged(i);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(i));
          }}
          onDragEnd={clearDrag}
          onDragOver={(event) => over(event, i)}
          onDrop={(event) =>
            commitDrop(
              event,
              dropTargetRef.current?.index === i ? dropTargetRef.current : targetFor(event, i)
            )
          }
        >
          {isFolder && (
            <IconButton
              label={t(closed ? 'native.expandLore' : 'native.collapseLore', {
                title: loreTitle(item),
              })}
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
                ? t('native.loreCount', {
                    count: parents.filter(
                      (parent, child) => parent === i && !isLoreFolder(entries[child])
                    ).length,
                  })
                : item.enabled === false
                  ? t('native.text_b2fd53af02')
                  : (moduleLore ? item.alwaysActive : item.constant)
                    ? t('native.text_e1590afe08')
                    : t('native.text_68500ad267')}
            </small>
          </button>
          <span
            className="nl-drag-handle"
            title={t('native.text_fb8317c25c')}
            aria-hidden="true"
            draggable
          >
            <DragHandleIcon size={16} />
          </span>
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
        {showList ? t('native.text_183ab69081') : t('native.text_b1ffe0e82c')}
      </button>
      <aside className="native-item-list nl-list" aria-label={t('native.text_bd814ee4e1')}>
        <input
          type="search"
          aria-label={t('native.text_7f169b78d6')}
          placeholder={t('native.text_ad125c2109')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="native-list-heading">
          <strong>
            {t('native.loreHeading', {
              count: entries.filter((item) => !isLoreFolder(item)).length,
            })}
          </strong>
          <IconButton
            label={t('native.text_5082d1ae8f')}
            icon={FolderAddIcon}
            onClick={() => add(true)}
          />
          <IconButton
            label={t('native.text_08882fa086')}
            icon={AddIcon}
            onClick={() => add(false)}
          />
        </div>
        <div className="nl-tree">
          {entries.map((_, i) => (parents[i] === null ? row(i, 0) : null))}
          {dragged !== null && (
            <div
              className="nl-root-drop"
              data-drop-active={dropTarget?.position === 'root' ? 'true' : undefined}
              onDragOver={(event) => {
                const sourceIndex = draggedRef.current;
                if (sourceIndex === null || !moveLoreEntry(entries, sourceIndex, null, 'root'))
                  return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                cancelExpand();
                dropTargetRef.current = { index: null, position: 'root' };
                setDropTarget({ index: null, position: 'root' });
              }}
              onDrop={(event) => commitDrop(event, { index: null, position: 'root' })}
            >
              {t('native.text_d484012528')}
            </div>
          )}
          {!visible.size && entries.length > 0 && (
            <p className="muted">{t('native.text_a9a4407910')}</p>
          )}
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {moveAnnouncement && t('native.loreMoved', moveAnnouncement)}
        </p>
        <details className="nl-policy">
          <summary>{t('native.text_f9dd023998')}</summary>
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
                label={folder ? t('native.text_8c30571e79') : t('native.text_f5bff252cf')}
                icon={UpIcon}
                disabled={position <= 0}
                onClick={() => move(-1)}
              />
              <IconButton
                label={folder ? t('native.text_77eceb1949') : t('native.text_f76cb3a668')}
                icon={DownIcon}
                disabled={position === siblings.length - 1}
                onClick={() => move(1)}
              />
              <IconButton
                label={folder ? t('native.text_7ef13fb182') : t('native.text_ef1dc8bce2')}
                icon={DeleteIcon}
                onClick={() => setDeleting(index)}
              />
            </div>
            <div className="nl-fields">
              <label>
                {folder ? t('native.text_0f5007a162') : t('native.text_178782beac')}
                <input
                  aria-label={folder ? t('native.text_0f5007a162') : t('native.text_3df0f8d368')}
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
                  {t('native.text_6d4aac6900')}
                  <select
                    aria-label={t('native.text_6d4aac6900')}
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
                    <option value="none">{t('native.text_5a5e447cb5')}</option>
                    <option value="conditional">{t('native.text_aaa63e0e3b')}</option>
                    <option value="always">{t('native.text_e1590afe08')}</option>
                  </select>
                </label>
              )}
            </div>
            <label>
              {t('native.text_aa8bd1a3a2')}
              <select
                aria-label={t('native.text_4a03992923')}
                value={loreText(entry.folder)}
                onChange={(e) => {
                  const next = { ...entry };
                  if (e.target.value) next.folder = e.target.value;
                  else delete next.folder;
                  onChange(entries.map((item, i) => (i === index ? next : item)));
                }}
              >
                <option value="">{t('native.text_3c1db0337a')}</option>
                {!!entry.folder &&
                  !folders.some(({ item }) => loreFolderKey(item) === entry.folder) && (
                    <option value={loreText(entry.folder)}>{t('native.text_11a333c615')}</option>
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
                <button type="button" className="secondary" onClick={() => add(false)}>
                  <AddIcon size={16} />
                  {t('native.text_caedf4822e')}
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
                  {t('native.text_bf0b828e2d')}
                  <textarea
                    className="native-main-text"
                    aria-label={t('native.text_bf0b828e2d')}
                    rows={16}
                    value={loreText(entry.content)}
                    onChange={(e) => edit({ content: e.target.value })}
                  />
                </label>
                <details className="native-advanced nl-advanced" key={index}>
                  <summary>{t('native.text_bf1eea5b75')}</summary>
                  <label>
                    {t('native.text_1922bfdd27')}
                    {moduleLore ? (
                      <input
                        aria-label={t('native.text_4fc1889a0b')}
                        value={loreText(entry.key)}
                        onChange={(e) => edit({ key: e.target.value })}
                      />
                    ) : (
                      <Keywords
                        key={index}
                        label={t('native.text_4fc1889a0b')}
                        value={entry.keys}
                        onChange={(keys) => edit({ keys })}
                      />
                    )}
                  </label>
                  <label className="check nl-switch">
                    {t('native.text_373aa98335')}
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
                      {t('native.text_e45a128fa4')}
                      {moduleLore ? (
                        <input
                          aria-label={t('native.text_e45a128fa4')}
                          value={loreText(entry.secondkey)}
                          onChange={(e) => edit({ secondkey: e.target.value })}
                        />
                      ) : (
                        <Keywords
                          key={index}
                          label={t('native.text_e45a128fa4')}
                          value={entry.secondary_keys}
                          onChange={(keys) => edit({ secondary_keys: keys })}
                        />
                      )}
                    </label>
                  )}
                  <label className="check nl-switch">
                    {t('native.text_1cbd14b035')}
                    <Switch
                      checked={(moduleLore ? entry.useRegex : entry.use_regex) === true}
                      onChange={(e) =>
                        edit({ [moduleLore ? 'useRegex' : 'use_regex']: e.target.checked })
                      }
                    />
                  </label>
                  <label>
                    {t('native.text_4abfa77902')}
                    <input
                      aria-label={t('native.text_d1e82c6e51')}
                      type="number"
                      value={Number(entry.insertorder ?? entry.insertion_order ?? 100)}
                      onChange={(e) =>
                        edit({
                          [moduleLore ? 'insertorder' : 'insertion_order']: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                </details>
              </>
            )}
          </>
        ) : (
          <div className="native-empty">
            <strong>{t('native.text_7cf50fd556')}</strong>
            <button type="button" onClick={() => add(false)}>
              {t('native.text_08882fa086')}
            </button>
            <button type="button" className="secondary" onClick={() => add(true)}>
              {t('native.text_5082d1ae8f')}
            </button>
          </div>
        )}
      </div>
      <Dialog
        open={deleting !== null}
        title={
          deleting !== null && isLoreFolder(entries[deleting])
            ? t('native.text_7ef13fb182')
            : t('native.text_12a6ec34b8')
        }
        role="alertdialog"
        className="delete-dialog"
        onClose={() => setDeleting(null)}
      >
        <p>
          {deleting !== null && isLoreFolder(entries[deleting])
            ? t('native.text_01d4ca79f9')
            : t('native.text_a6965f7538')}
        </p>
        <div className="form-actions">
          <button type="button" className="secondary" onClick={() => setDeleting(null)}>
            <CloseIcon size={18} aria-hidden="true" />
            {t('native.text_19b2d19bc1')}
          </button>
          <button
            type="button"
            className="delete-button"
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
            {deleting !== null && isLoreFolder(entries[deleting])
              ? t('native.text_238e78a780')
              : t('native.text_12a6ec34b8')}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
