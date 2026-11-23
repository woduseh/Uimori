import { useEffect, useState, type ReactNode } from 'react';
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
      <div className="story-board-body">
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
