import { useState, type DragEvent, type ReactNode } from 'react';
import { IconButton } from './IconButton.js';
import { AddIcon, UpIcon, DownIcon, DeleteIcon, DragHandleIcon } from './ui-icons.js';

export function NativeCollectionEditor({
  label,
  items,
  onAdd,
  onMove,
  onReorder,
  onRemove,
  children,
}: {
  label: string;
  items: { title: string; subtitle?: string }[];
  onAdd: () => void;
  onMove?: (index: number, delta: number) => void;
  onReorder?: (from: number, to: number) => void;
  onRemove?: (index: number) => void;
  children: (index: number) => ReactNode;
}) {
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const [dragged, setDragged] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    index: number;
    position: 'before' | 'after';
  } | null>(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState('');
  const index = Math.min(selected, Math.max(0, items.length - 1));
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
    setMoveAnnouncement(`${items[from].title} 항목을 ${to + 1}번째로 이동했어요.`);
  };
  return (
    <div className="native-editor-split">
      <aside className="native-item-list" aria-label={label + ' 목록'}>
        <input
          type="search"
          aria-label={label + ' 찾기'}
          placeholder={label + ' 찾기'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="native-list-heading">
          <strong>
            {label} · {items.length}
          </strong>
          <IconButton label={label + ' 추가'} icon={AddIcon} onClick={add} />
        </div>
        {items
          .map((item, i) => ({ item, i }))
          .filter(({ item }) => item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
          .map(({ item, i }) => (
            <button
              type="button"
              key={i}
              aria-current={index === i ? 'true' : undefined}
              data-dragging={dragged === i ? 'true' : undefined}
              data-drop-position={dropTarget?.index === i ? dropTarget.position : undefined}
              draggable={!!onReorder}
              title={onReorder ? '끌어서 순서 변경' : undefined}
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
        <p className="sr-only" role="status" aria-live="polite">
          {moveAnnouncement}
        </p>
      </aside>
      <div className="native-item-detail">
        <div className="native-mobile-picker">
          <button type="button" disabled={index === 0} onClick={() => setSelected(index - 1)}>
            이전
          </button>
          <select
            aria-label={'현재 ' + label}
            value={index}
            onChange={(e) => setSelected(Number(e.target.value))}
          >
            {items.map((item, i) => (
              <option key={i} value={i}>
                {item.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={index >= items.length - 1}
            onClick={() => setSelected(index + 1)}
          >
            다음
          </button>
          <IconButton label={label + ' 추가'} icon={AddIcon} onClick={add} />
        </div>
        {items[index] ? (
          <>
            <div className="native-detail-heading">
              <h3>{items[index].title}</h3>
              {onMove && (
                <>
                  <IconButton
                    label={label + ' 위로'}
                    icon={UpIcon}
                    disabled={index === 0}
                    onClick={() => {
                      onMove(index, -1);
                      setSelected(index - 1);
                    }}
                  />
                  <IconButton
                    label={label + ' 아래로'}
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
                  label={'선택한 ' + label + ' 삭제'}
                  icon={DeleteIcon}
                  onClick={() => {
                    onRemove(index);
                    setSelected(Math.max(0, index - 1));
                  }}
                />
              )}
            </div>
            {children(index)}
          </>
        ) : (
          <div className="native-empty">
            <strong>아직 {label} 항목이 없어요.</strong>
            <p className="muted">첫 항목을 추가해 편집을 시작하세요.</p>
            <button type="button" onClick={add}>
              {label} 추가
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
