import { t, useI18n, formatNumber } from './i18n.js';
import { themeBodyScroll } from './theme-body-scroll.js';
import { BookmarkList } from './Bookmarks.js';
import type { ReaderTarget } from '../core/reader-target.js';
import { ManuscriptSearchPanel } from './ManuscriptSearch.js';
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { DownIcon, ListIcon, EditIcon } from './ui-icons.js';
import type { ReaderDetail, ReaderNavigationItem } from '../core/types.js';
import { Dialog } from './Dialog.js';
import { IconButton } from './IconButton.js';
import { SceneTitleEditor } from './SceneTitleEditor.js';
import './scene-navigator.css';

export function SceneNavigator({
  detail,
  reader,
  target,
  onSelect,
  onTarget,
  onLatest,
  compact = false,
  onLatestVisibilityChange,
  listOpen,
  onListOpenChange,
  onCurrentLabel,
  compactListOpener,
}: {
  detail: ReaderDetail;
  reader: RefObject<HTMLDivElement | null>;
  target: string;
  onSelect: (id: string) => void;
  onTarget?: (target: ReaderTarget) => void;
  onLatest: () => void;
  /** Compact widths keep the scene dialog here and surface jump visibility to the composer. */
  compact?: boolean;
  onLatestVisibilityChange?: (visible: boolean) => void;
  /** One list state survives switches between the header opener and desktop rail. */
  listOpen: boolean;
  onListOpenChange: (open: boolean) => void;
  onCurrentLabel?: (label: string) => void;
  compactListOpener?: RefObject<HTMLButtonElement | null>;
}) {
  useI18n();
  const entries = detail.reader.navigation;
  const [current, setCurrent] = useState(target || detail.reader.order[0] || '');
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState<ReaderNavigationItem | null>(null);
  const open = listOpen;
  const setOpen = onListOpenChange;
  const [query, setQuery] = useState('');
  const [searchTarget, setSearchTarget] = useState<'scenes' | 'manuscript'>('scenes');
  const [composing, setComposing] = useState(false);
  const searchFormId = useId();
  const [offset, setOffset] = useState(0);
  const [capacity, setCapacity] = useState(20);
  const list = useRef<HTMLOListElement>(null);
  const railListOpener = useRef<HTMLButtonElement>(null);
  const focusList = useRef(false);
  const orderKey = detail.reader.order.join(',');
  useEffect(() => {
    const node = reader.current;
    if (!node || !orderKey) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const distance = node.scrollHeight - node.clientHeight - node.scrollTop;
      const sources = [...node.querySelectorAll<HTMLElement>('[data-testid="source"]')];
      const lastBody = themeBodyScroll(sources.at(-1) ?? null);
      const bodyDistance = lastBody
        ? lastBody.scrollHeight - lastBody.clientHeight - lastBody.scrollTop
        : 0;
      // Keep the mobile jump control quiet near the end. Small font/layout changes
      // should not make it linger when the reader is effectively at the latest text.
      setAwayFromBottom(
        distance > Math.max(120, node.clientHeight * 0.14) ||
          bodyDistance > Math.max(24, (lastBody?.clientHeight ?? 0) * 0.08)
      );
      const top = node.getBoundingClientRect().top + 32;
      // At the physical end, the last source is the scene being read even when the
      // page layout leaves a sliver of the previous source visible.
      const visible =
        distance <= 2
          ? sources.at(-1)
          : (sources.find((source) => source.getBoundingClientRect().bottom > top) ??
            sources.at(-1));
      if (visible?.dataset.sourceId) setCurrent(visible.dataset.sourceId);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(node);
    if (node.firstElementChild) resize.observe(node.firstElementChild);
    node.addEventListener('scroll', schedule, { passive: true, capture: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      node.removeEventListener('scroll', schedule, true);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: Opening starts at the scene being read; resizing an open list preserves its query and page.
  useEffect(() => {
    if (listOpen) {
      setQuery('');
      setOffset(Math.floor(index / 60) * 60);
    }
  }, [listOpen]);
  const active = entries[index];
  const last = entries.at(-1);
  const canGoLatest = awayFromBottom || last?.id !== detail.reader.order.at(-1);
  useEffect(() => {
    if (compact) onLatestVisibilityChange?.(canGoLatest);
  }, [compact, canGoLatest, onLatestVisibilityChange]);
  const count = Math.min(capacity, entries.length);
  const marks = new Set<number>();
  for (let i = 0; i < count; i++)
    marks.add(count === 1 ? 0 : Math.round((i * (entries.length - 1)) / (count - 1)));
  marks.add(index);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? entries.filter((entry) =>
          `${entry.number} ${entry.label} ${entry.requestLabel ?? ''}`
            .toLocaleLowerCase()
            .includes(term)
        )
      : entries;
  }, [entries, query]);
  const page = filtered.slice(offset, offset + 60);
  const sceneCount = entries.filter((entry) => !entry.opening).length;
  const currentLabel = active
    ? active.opening
      ? t('reader.openingMessage2')
      : `${formatNumber(active.number)} / ${formatNumber(sceneCount)}`
    : '';
  useEffect(() => {
    onCurrentLabel?.(currentLabel);
  }, [currentLabel, onCurrentLabel]);
  function select(id: string) {
    setOpen(false);
    onSelect(id);
  }
  function changePage(next: number) {
    focusList.current = true;
    setOffset(next);
  }
  if (!entries.length) return null;
  const titleEditor = editingTitle && (
    <SceneTitleEditor
      key={editingTitle.id}
      item={editingTitle}
      onClose={() => setEditingTitle(null)}
    />
  );
  const dialog = (
    <Dialog
      open={open}
      title={t('reader.sceneList')}
      onClose={() => setOpen(false)}
      onAfterClose={() => {
        // Resizing can replace the original opener while the native dialog stays open.
        (compact ? compactListOpener?.current : railListOpener.current)?.focus({
          preventScroll: true,
        });
      }}
      className="scene-dialog"
    >
      {onTarget && (
        <details onToggle={(event) => setBookmarksOpen(event.currentTarget.open)}>
          <summary>{t('reader.bookmarks')}</summary>
          {open && bookmarksOpen && (
            <BookmarkList
              chatId={detail.chat.id}
              onNavigate={(target) => {
                setOpen(false);
                onTarget(target);
              }}
            />
          )}
        </details>
      )}
      <label className="scene-search">
        <input
          type="search"
          form={searchTarget === 'manuscript' ? searchFormId : undefined}
          aria-label={t('reader.sceneSearchQuery')}
          placeholder={
            searchTarget === 'scenes'
              ? t('reader.findBySceneNumberNameOrRequest')
              : t('reader.findInTextTranslationsAndRequests')
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229)
              return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }}
        />
      </label>
      {onTarget && (
        <div className="segmented" role="group" aria-label={t('reader.sceneSearchScope')}>
          <button
            type="button"
            aria-pressed={searchTarget === 'scenes'}
            onClick={() => setSearchTarget('scenes')}
          >
            {t('reader.sceneList')}
          </button>
          <button
            type="button"
            aria-pressed={searchTarget === 'manuscript'}
            onClick={() => setSearchTarget('manuscript')}
          >
            {t('reader.text')}
          </button>
        </div>
      )}
      {searchTarget === 'manuscript' && onTarget ? (
        <ManuscriptSearchPanel
          initialScope="chat"
          chatId={detail.chat.id}
          botId={detail.chat.botId}
          query={query}
          queryComposing={composing}
          hideQueryInput
          formId={searchFormId}
          onNavigate={(target) => {
            setOpen(false);
            onTarget(target);
          }}
        />
      ) : (
        <>
          {sceneCount > 0 && (
            <p className="scene-list-count">{t('reader.sceneCount', { count: sceneCount })}</p>
          )}
          <ol className="scene-list" start={offset + 1} ref={list}>
            {page.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-current={entry.id === active.id ? 'location' : undefined}
                  aria-label={
                    entry.opening
                      ? entry.label
                      : t('reader.sceneValueValue', {
                          v0: formatNumber(entry.number),
                          v1: entry.label,
                        })
                  }
                  onClick={() => select(entry.id)}
                >
                  <span className="scene-list-number" aria-hidden="true">
                    {entry.opening ? <ListIcon size={16} /> : formatNumber(entry.number)}
                  </span>
                  <span className="scene-list-title">{entry.label}</span>
                  {entry.id === active.id && <small>{t('reader.reading')}</small>}
                </button>
                <IconButton
                  label={t('reader.sceneNameAction', {
                    opening: !!entry.opening,
                    number: formatNumber(entry.number),
                  })}
                  icon={EditIcon}
                  size={16}
                  className="scene-title-edit"
                  onClick={() => setEditingTitle(entry)}
                />
              </li>
            ))}
          </ol>
          {!filtered.length && <p role="status">{t('reader.noMatchingScenes')}</p>}
          {filtered.length > 60 && (
            <div className="scene-list-pages">
              <button
                type="button"
                className="secondary"
                disabled={offset === 0}
                onClick={() => changePage(Math.max(0, offset - 60))}
              >
                {t('reader.previousList')}
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
                {t('reader.nextList')}
              </button>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
  if (compact)
    return (
      <>
        {titleEditor}
        {dialog}
      </>
    );
  return (
    <>
      <nav className="scene-navigator" aria-label={t('reader.sceneNavigation')}>
        <button
          type="button"
          ref={railListOpener}
          className="scene-list-toggle"
          aria-label={t('reader.openSceneList')}
          title={t('reader.openSceneList')}
          onClick={openList}
        >
          <ListIcon size={18} />
          <span>
            {active.opening
              ? t('reader.openingMessage2')
              : `${active.number} / ${entries.filter((entry) => !entry.opening).length}`}
          </span>
        </button>
        <div
          className="scene-marks"
          aria-label={
            entries.length > capacity
              ? t('reader.partialSceneScaleSelectAnySceneFromTheList')
              : t('reader.sceneScale')
          }
        >
          {[...marks]
            .sort((a, b) => a - b)
            .map((i) => {
              const entry = entries[i];
              const label = entry.opening
                ? entry.label
                : t('reader.sceneValueValue', { v0: formatNumber(entry.number), v1: entry.label });
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
          aria-label={t('reader.goToTheBottomOfTheText')}
          title={t('reader.goToTheBottomOfTheText')}
          disabled={!canGoLatest}
          onClick={onLatest}
        >
          <DownIcon size={18} />
        </button>
      </nav>
      {titleEditor}
      {dialog}
    </>
  );
}
