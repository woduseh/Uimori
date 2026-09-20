import { useState, type ReactNode } from 'react';
import { IconButton } from './IconButton.js';
import { AddIcon, UpIcon, DownIcon, DeleteIcon } from './ui-icons.js';

export function NativeCollectionEditor({
  label,
  items,
  onAdd,
  onMove,
  onRemove,
  children,
}: {
  label: string;
  items: { title: string; subtitle?: string }[];
  onAdd: () => void;
  onMove?: (index: number, delta: number) => void;
  onRemove?: (index: number) => void;
  children: (index: number) => ReactNode;
}) {
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const index = Math.min(selected, Math.max(0, items.length - 1));
  const add = () => {
    onAdd();
    setSelected(items.length);
    setQuery('');
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
              onClick={() => setSelected(i)}
            >
              <strong>{item.title}</strong>
              {item.subtitle && <small>{item.subtitle}</small>}
            </button>
          ))}
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
            <p className="muted">아직 {label} 항목이 없어요.</p>
            <button type="button" onClick={add}>
              {label} 추가
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
