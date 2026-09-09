import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { DownIcon, ListIcon } from './ui-icons.js';
import type { ReaderDetail } from '../core/types.js';
import { Dialog } from './Dialog.js';
import './scene-navigator.css';

export function SceneNavigator({
  detail,
  reader,
  target,
  onSelect,
  compact = false,
  listOpen = false,
  onListOpenChange,
}: {
  detail: ReaderDetail;
  reader: RefObject<HTMLDivElement | null>;
  target: string;
  onSelect: (id: string) => void;
  /** Compact widths have no rail: the header title opens the list and a floating button jumps to the latest scene. */
  compact?: boolean;
  /** Controlled list state on compact widths (the header owns the opener). */
  listOpen?: boolean;
  onListOpenChange?: (open: boolean) => void;
}) {
  const entries = detail.reader.navigation;
  const [current, setCurrent] = useState(target || detail.reader.order[0] || '');
  const [ownOpen, setOwnOpen] = useState(false);
  const open = compact ? listOpen : ownOpen;
  const setOpen = (next: boolean) => {
    if (compact) onListOpenChange?.(next);
    else setOwnOpen(next);
  };
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [capacity, setCapacity] = useState(20);
  const list = useRef<HTMLOListElement>(null);
  const focusList = useRef(false);
  const orderKey = detail.reader.order.join(',');
  useEffect(() => {
    const node = reader.current;
    if (!node || !orderKey) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = node.getBoundingClientRect().top + 32;
      const sources = [...node.querySelectorAll<HTMLElement>('[data-testid="source"]')];
      const visible =
        sources.find((source) => source.getBoundingClientRect().bottom > top) ?? sources.at(-1);
      if (visible?.dataset.sourceId) setCurrent(visible.dataset.sourceId);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(node);
    for (const source of node.querySelectorAll('[data-testid="source"]')) resize.observe(source);
    node.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      node.removeEventListener('scroll', schedule);
    };
    // Observe the mounted page again when paging replaces its source elements.
  }, [reader, orderKey]);
  useEffect(() => {
    const node = reader.current?.parentElement;
    if (!node) return;
    const resize = new ResizeObserver(() =>
      setCapacity(Math.max(3, Math.min(32, Math.floor((node.clientHeight - 120) / 18))))
    );
    resize.observe(node);
    return () => resize.disconnect();
  }, [reader]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Focus the new page only after its offset has committed to the DOM.
  useEffect(() => {
    if (!focusList.current) return;
    focusList.current = false;
    const first = list.current?.querySelector('button');
    first?.focus();
    const body = list.current?.closest('.dialog-body');
    if (body) body.scrollTop = 0;
  }, [offset]);
  const index = Math.max(
    0,
    entries.findIndex((entry) => entry.id === current)
  );
  function openList() {
    setQuery('');
    setOffset(Math.floor(index / 60) * 60);
    setOpen(true);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: The header opener only signals; the list starts from the scene being read at that moment.
  useEffect(() => {
    if (compact && listOpen) {
      setQuery('');
      setOffset(Math.floor(index / 60) * 60);
    }
  }, [compact, listOpen]);
  const active = entries[index];
  const last = entries.at(-1);
  const count = Math.min(capacity, entries.length);
  const marks = new Set<number>();
  for (let i = 0; i < count; i++)
    marks.add(count === 1 ? 0 : Math.round((i * (entries.length - 1)) / (count - 1)));
  marks.add(index);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? entries.filter((entry) =>
          `${entry.number} ${entry.label}`.toLocaleLowerCase().includes(term)
        )
      : entries;
  }, [entries, query]);
  const page = filtered.slice(offset, offset + 60);
  function select(id: string) {
    setOpen(false);
    onSelect(id);
  }
  function changePage(next: number) {
    focusList.current = true;
    setOffset(next);
  }
  if (!entries.length) return null;
  const dialog = (
    <Dialog open={open} title="장면 목록" onClose={() => setOpen(false)} className="scene-dialog">
      <label className="scene-search">
        장면 번호 또는 요청으로 찾기
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
        />
      </label>
      <p className="muted">
        현재 분기 · {entries.length}개 장면
        {!compact && entries.length > capacity ? ' · 눈금에는 일부 장면을 표시해요.' : ''}
      </p>
      <ol className="scene-list" start={offset + 1} ref={list}>
        {page.map((entry) => (
          <li key={entry.id}>
            <button
              type="button"
              aria-current={entry.id === active.id ? 'location' : undefined}
              aria-label={`${entry.number}번째 장면 · ${entry.label}`}
              onClick={() => select(entry.id)}
            >
              <span>{entry.number}</span>
              <span>{entry.label}</span>
              {entry.id === active.id && <small>읽는 중</small>}
            </button>
          </li>
        ))}
      </ol>
      {!filtered.length && <p role="status">일치하는 장면이 없어요.</p>}
      {filtered.length > 60 && (
        <div className="scene-list-pages">
          <button
            type="button"
            className="secondary"
            disabled={offset === 0}
            onClick={() => changePage(Math.max(0, offset - 60))}
          >
            이전 목록
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 60, filtered.length)} / {filtered.length}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={offset + 60 >= filtered.length}
            onClick={() => changePage(offset + 60)}
          >
            다음 목록
          </button>
        </div>
      )}
    </Dialog>
  );
  if (compact)
    return (
      <>
        {last && current !== last.id && (
          <button
            type="button"
            className="scene-latest-floating"
            aria-label="최신 장면으로"
            title="최신 장면으로"
            onClick={() => select(last.id)}
          >
            <DownIcon size={20} aria-hidden="true" />
          </button>
        )}
        {dialog}
      </>
    );
  return (
    <>
      <nav className="scene-navigator" aria-label="장면 탐색">
        <button
          type="button"
          className="scene-list-toggle"
          aria-label="장면 목록 열기"
          title="장면 목록 열기"
          onClick={openList}
        >
          <ListIcon size={18} />
          <span>
            {active.number} / {entries.length}
          </span>
        </button>
        <div
          className="scene-marks"
          aria-label={
            entries.length > capacity ? '일부 장면 눈금 · 전체 장면은 목록에서 선택' : '장면 눈금'
          }
        >
          {[...marks]
            .sort((a, b) => a - b)
            .map((i) => {
              const entry = entries[i];
              const label = `${entry.number}번째 장면 · ${entry.label}`;
              return (
                <button
                  type="button"
                  key={entry.id}
                  className="scene-mark"
                  aria-label={label}
                  aria-current={entry.id === active.id ? 'location' : undefined}
                  onClick={() => select(entry.id)}
                >
                  <span className="scene-tick" />
                  <span className="scene-preview" aria-hidden="true">
                    {label}
                  </span>
                </button>
              );
            })}
        </div>
        <button
          type="button"
          className="scene-latest"
          aria-label="최신 장면으로"
          title="최신 장면으로"
          disabled={current === last?.id}
          onClick={() => last && select(last.id)}
        >
          <DownIcon size={18} />
        </button>
      </nav>
      {dialog}
    </>
  );
}
