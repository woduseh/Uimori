import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { StoryUiSegment } from '../core/story-ui-scan.js';
import type { StoryUiStyleSetting } from '../core/story-ui-style.js';
import type { Job, Source } from '../core/types.js';
import { api } from './api.js';
import { t, useI18n } from './i18n.js';
import { IconButton } from './IconButton.js';
import { LoadingState } from './LoadingState.js';
import { StoryUi } from './LazyStoryUi.js';
import { ScrollStrip } from './ScrollStrip.js';
import { CloseIcon } from './ui-icons.js';
import { scopedStoryBoardCss, useStoryUiPresentation } from './story-ui-theme.js';
import { storyUiPreview } from './story-ui-preview.js';
import type { ThemeDefinition } from '../core/themes.js';
import './story-board.css';

type UiSegment = Extract<StoryUiSegment, { kind: 'ui' }>;
export type StoryBoardPin = {
  slot: string;
  sourceId: string;
  original: UiSegment;
  translated?: UiSegment;
};

export function hasStoryBoardPins(sources: readonly Source[]) {
  return sources.some((source) => source.text.includes('"pin":"'));
}

export function useStoryBoard(
  chatId: string,
  at: string | undefined,
  sources: readonly Source[],
  jobs: readonly Job[] = []
) {
  const [pins, setPins] = useState<StoryBoardPin[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pinned = !!chatId && hasStoryBoardPins(sources);
  const revision = [
    ...sources.map((source) => source.hash),
    ...jobs
      .filter((job) => job.kind === 'translation' && job.status === 'completed')
      .map((job) => job.id),
  ].join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision changes when a scene or its translation does, which changes the pinned blocks.
  useEffect(() => {
    if (!pinned) {
      setPins([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<{ pins: StoryBoardPin[] }>(
      `/chats/${encodeURIComponent(chatId)}/story-ui/pins${at ? `?at=${encodeURIComponent(at)}` : ''}`,
      undefined,
      'GET',
      controller.signal
    )
      .then((result) => setPins(result.pins))
      .catch((cause) => {
        if (!controller.signal.aborted) setError((cause as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [pinned, chatId, at, revision]);
  return { available: pinned, pins, loading, error };
}

function boardTitle(pin: StoryBoardPin) {
  const message = pin.original.messages[0] as {
    createSurface?: { components?: { id: string; title?: unknown }[] };
  };
  const title = message.createSurface?.components?.find((item) => item.id === 'root')?.title;
  return typeof title === 'string' && title.trim() ? title : pin.slot;
}

export function StoryBoardPanel({
  open,
  modal,
  tabs,
  onClose,
  board,
  style,
  translated,
}: {
  open: boolean;
  modal?: boolean;
  tabs?: (close: () => void) => ReactNode;
  onClose: () => void;
  board: ReturnType<typeof useStoryBoard>;
  style?: StoryUiStyleSetting;
  translated: boolean;
}) {
  useI18n();
  const [selected, setSelected] = useState('');
  const pin = board.pins.find((item) => item.slot === selected) ?? board.pins[0];
  const segment = (translated && pin?.translated) || pin?.original;
  const boardId = useId();
  const presentation = useStoryUiPresentation(style, segment?.messages);
  const theme = presentation.theme?.storyUi;
  const boardCss = useMemo(
    () => scopedStoryBoardCss(theme?.boardCss ?? '', boardId),
    [theme?.boardCss, boardId]
  );
  const matched =
    segment && !theme && presentation.style !== 'default' ? presentation.style : undefined;
  return (
    <aside
      id="story-board-panel"
      className="story-board-panel"
      hidden={!open}
      role={modal ? 'dialog' : 'region'}
      aria-modal={modal && open ? true : undefined}
      aria-label={t('storyUi.boardLabel')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        onClose();
      }}
    >
      {tabs ? (
        tabs(onClose)
      ) : (
        <header className="story-board-header">
          <h2>{t('storyUi.boardLabel')}</h2>
          <IconButton
            label={t('shared.close', { title: t('storyUi.boardLabel') })}
            icon={CloseIcon}
            onClick={onClose}
          />
        </header>
      )}
      <div
        className={matched ? 'story-board-body story-ui-tokens' : 'story-board-body'}
        data-story-ui-style={matched}
        data-story-board-custom={boardCss ? boardId : undefined}
      >
        {boardCss && <style>{boardCss}</style>}
        {board.pins.length > 1 && (
          <ScrollStrip
            className="story-board-slots"
            role="tablist"
            aria-label={t('storyUi.boardSlots')}
          >
            {board.pins.map((item) => (
              <button
                key={item.slot}
                type="button"
                role="tab"
                className="secondary"
                aria-selected={item === pin}
                tabIndex={item === pin ? 0 : -1}
                onClick={() => setSelected(item.slot)}
              >
                {boardTitle(item)}
              </button>
            ))}
          </ScrollStrip>
        )}
        {segment ? (
          <StoryUi
            key={`${pin.sourceId}:${segment.id}:${translated && pin.translated ? 't' : 'o'}`}
            segment={segment}
            style={style}
            actionNote={t('storyUi.boardAction')}
          />
        ) : board.loading || board.error ? (
          <LoadingState loading={board.loading} error={board.error} />
        ) : (
          <p className="story-board-empty">{t('storyUi.boardEmpty')}</p>
        )}
      </div>
    </aside>
  );
}

export function StoryUiThemePreview({ storyUi }: { storyUi: ThemeDefinition['storyUi'] }) {
  useI18n();
  const boardId = useId();
  const boardCss = useMemo(
    () => scopedStoryBoardCss(storyUi?.boardCss ?? '', boardId),
    [storyUi?.boardCss, boardId]
  );
  const block = <StoryUi segment={storyUiPreview} customTheme={storyUi} />;
  if (!boardCss) return block;
  return (
    <div className="story-board-body story-board-preview" data-story-board-custom={boardId}>
      <style>{boardCss}</style>
      <ScrollStrip
        className="story-board-slots"
        role="tablist"
        aria-label={t('storyUi.boardSlots')}
      >
        {[t('storyUi.board'), t('storyUi.boardPreviewSlot')].map((label, index) => (
          <button
            key={label}
            type="button"
            role="tab"
            className="secondary"
            aria-selected={index === 0}
            tabIndex={index === 0 ? 0 : -1}
          >
            {label}
          </button>
        ))}
      </ScrollStrip>
      {block}
    </div>
  );
}
