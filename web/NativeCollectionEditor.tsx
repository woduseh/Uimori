import { useI18n, formatNumber } from './i18n.js';
import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { IconButton } from './IconButton.js';
import { NativeDeleteDialog } from './NativeDeleteDialog.js';
import { AddIcon, UpIcon, DownIcon, DeleteIcon, DragHandleIcon } from './ui-icons.js';
import { useStudioItem } from './EditorStudio.js';
import { EditorHelperItemAction } from './EditorHelperAction.js';

export function NativeCollectionEditor({
  label,
  items,
  onAdd,
  onMove,
  onReorder,
  onRemove,
  isEmpty,
  actions,
  focus = null,
  children,
}: {
  focus?: { index: number; epoch: number } | null;
  label: string;
  items: { title: string; subtitle?: string }[];
  onAdd: () => void;
  onMove?: (index: number, delta: number) => void;
  onReorder?: (from: number, to: number) => void;
  onRemove?: (index: number) => void;
  isEmpty?: (index: number) => boolean;
  actions?: ReactNode;
  children: (index: number) => ReactNode;
}) {
  const { t } = useI18n();

  const [selected, setSelected] = useState(focus?.index ?? 0);
  const [query, setQuery] = useState('');
  const focused = useRef(focus?.epoch);
  useEffect(() => {
    if (!focus || focused.current === focus.epoch) return;
    focused.current = focus.epoch;
    setSelected(focus.index);
    setQuery('');
  }, [focus]);
  const [dragged, setDragged] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    index: number;
    position: 'before' | 'after';
  } | null>(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState<{
    title: string;
    position: number;
  } | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [removals, setRemovals] = useState(0);
  const index = Math.min(selected, Math.max(0, items.length - 1));
  useStudioItem(items[index] ? index : null, items[index]?.title ?? '');
  const remove = (target: number) => {
    setRemoving(null);
    onRemove?.(target);
    setRemovals((count) => count + 1);
    setSelected(Math.max(0, target - 1));
  };
  const found = items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const add = () => {
    onAdd();
    setSelected(items.length);
    setQuery('');
  };
  const targetFor = (event: DragEvent<HTMLButtonElement>, targetIndex: number) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      index: targetIndex,
      position: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
    } as const;
  };
  const clearDrag = () => {
    setDragged(null);
    setDropTarget(null);
  };
  const drop = (
    event: DragEvent<HTMLButtonElement>,
    target: { index: number; position: 'before' | 'after' }
  ) => {
    event.preventDefault();
    const from = dragged;
    clearDrag();
    if (from === null || !onReorder) return;
    let to = target.index + (target.position === 'after' ? 1 : 0);
    if (from < to) to -= 1;
    if (from === to) return;
    onReorder(from, to);
    setSelected(to);
    setMoveAnnouncement({ title: items[from].title, position: to + 1 });
  };
  return (
    <div className="native-editor-split">
      <aside className="native-item-list" aria-label={t('native.collectionList', { label })}>
        <input
          type="search"
          aria-label={t('native.collectionFind', { label })}
          placeholder={t('native.collectionFind', { label })}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="native-list-heading">
          <strong className="ui-meta-row">
            <span>{label}</span>
            <span>{formatNumber(items.length)}</span>
          </strong>
          <IconButton label={t('native.collectionAdd', { label })} icon={AddIcon} onClick={add} />
        </div>
        {found.map(({ item, i }) => (
          <button
            type="button"
            key={i}
            data-studio-item={i}
            aria-current={index === i ? 'true' : undefined}
            data-dragging={dragged === i ? 'true' : undefined}
            data-drop-position={dropTarget?.index === i ? dropTarget.position : undefined}
            draggable={!!onReorder}
            title={onReorder ? t('native.text_52df394c6c') : undefined}
            onClick={() => setSelected(i)}
            onDragStart={(event) => {
              if (!onReorder) return;
              setSelected(i);
              setDragged(i);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', String(i));
            }}
            onDragEnd={clearDrag}
            onDragOver={(event) => {
              if (dragged === null || !onReorder) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropTarget(targetFor(event, i));
              const list = event.currentTarget.closest('.native-item-list');
              if (list) {
                const bounds = list.getBoundingClientRect();
                if (event.clientY < bounds.top + 36) list.scrollTop -= 12;
                if (event.clientY > bounds.bottom - 36) list.scrollTop += 12;
              }
            }}
            onDrop={(event) => drop(event, targetFor(event, i))}
          >
            <strong>{item.title}</strong>
            {item.subtitle && <small>{item.subtitle}</small>}
            {onReorder && (
              <span className="native-row-drag-handle" aria-hidden="true">
                <DragHandleIcon size={16} />
              </span>
            )}
          </button>
        ))}
        {!!items.length && !!query && !found.length && (
          <div className="native-list-empty">
            <p role="status">{t('native.text_a9a4407910')}</p>
            <button type="button" className="ghost" onClick={() => setQuery('')}>
              {t('library.clearSearch')}
            </button>
          </div>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {moveAnnouncement && t('native.collectionMoved', moveAnnouncement)}
        </p>
      </aside>
      <div className="native-item-detail">
        {items.length > 0 && (
          <div className="native-mobile-picker">
            <select
              aria-label={t('native.collectionCurrent', { label })}
              value={index}
              onChange={(e) => setSelected(Number(e.target.value))}
            >
              {items.map((item, i) => (
                <option key={i} value={i}>
                  {item.title}
                </option>
              ))}
            </select>
            <IconButton label={t('native.collectionAdd', { label })} icon={AddIcon} onClick={add} />
          </div>
        )}
        {items[index] ? (
          <>
            <div className="native-detail-heading">
              <h3>{items[index].title}</h3>
              {actions}
              <EditorHelperItemAction index={index} label={items[index].title} />
              {onMove && items.length > 1 && (
                <>
                  <IconButton
                    label={t('native.collectionUp', { label })}
                    icon={UpIcon}
                    disabled={index === 0}
                    onClick={() => {
                      onMove(index, -1);
                      setSelected(index - 1);
                    }}
                  />
                  <IconButton
                    label={t('native.collectionDown', { label })}
                    icon={DownIcon}
                    disabled={index === items.length - 1}
                    onClick={() => {
                      onMove(index, 1);
                      setSelected(index + 1);
                    }}
                  />
                </>
              )}
              {onRemove && (
                <IconButton
                  label={t('native.collectionDelete', { label })}
                  icon={DeleteIcon}
                  onClick={() => (isEmpty?.(index) ? remove(index) : setRemoving(index))}
                />
              )}
            </div>
            <Fragment key={removals}>{children(index)}</Fragment>
          </>
        ) : (
          <div className="native-empty">
            <strong>{t('native.collectionEmpty', { label })}</strong>
            <button type="button" onClick={add}>
              {t('native.collectionAdd', { label })}
            </button>
          </div>
        )}
      </div>
      <NativeDeleteDialog
        target={removing === null ? null : (items[removing]?.title ?? '')}
        action={t('native.collectionDeleteConfirm', { label })}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing !== null) remove(removing);
        }}
      />
    </div>
  );
}
