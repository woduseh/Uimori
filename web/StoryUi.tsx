import { A2uiSurface, MarkdownContext, type ReactCatalogComponent } from '@a2ui/react';
import { MessageProcessor, type ActionPayload } from '@a2ui/web_core';
import { useEffect, useRef, useState } from 'react';
import { resolveStoryUiStyle } from '../core/story-ui-style.js';
import type { StoryUiSegment } from '../core/story-ui.js';
import type { Run } from '../core/types.js';
import { compileReadingMarkdown } from '../core/reading-markdown.js';
import { api, ApiError, definiteRejection } from './api.js';
import { t } from './i18n.js';
import { storyUiRenderCatalog } from './story-ui-catalog.js';
import './story-ui.css';
import { readStoryUiDraft, storyUiDraftChanges, writeStoryUiDraft } from './story-ui-draft.js';

type UiSegment = Extract<StoryUiSegment, { kind: 'ui' }>;
type Command = { body: Record<string, unknown>; uncertain: boolean };
const commands = new Map<string, Command>();
const renderMarkdown = async (markdown: string) => compileReadingMarkdown(markdown).html;

export function StoryUi({
  segment,
  chatId,
  sourceId,
  sourceHash,
  latest,
  refresh,
  actionBlockId,
  beginAdmission,
  style,
}: {
  segment: UiSegment;
  style?: import('../core/story-ui-style.js').StoryUiStyleSetting;
  chatId?: string;
  sourceId?: string;
  sourceHash?: string;
  latest?: boolean;
  refresh?: () => Promise<void>;
  actionBlockId?: string;
  beginAdmission?: () => (run: Run) => void;
}) {
  const [action, setAction] = useState<ActionPayload>();
  const [mode, setMode] = useState<'short' | 'continue'>('short');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failure, setFailure] = useState<ApiError>();
  const [uncertain, setUncertain] = useState(false);
  const callback = useRef(setAction);
  const draftKey =
    sourceId && sourceHash
      ? `uimori:story-ui-draft:${chatId}:${sourceId}:${sourceHash}:${actionBlockId ?? segment.id}`
      : undefined;
  callback.current = (next) => {
    if (!uncertain && !pending) setAction(next);
  };
  const [processor] = useState(() => {
    const result = new MessageProcessor<ReactCatalogComponent>([storyUiRenderCatalog], (payload) =>
      callback.current(payload)
    );
    try {
      result.processMessages(segment.messages);
      return result;
    } catch {
      result.dispose();
      return null;
    }
  });
  useEffect(() => () => processor?.dispose(), [processor]);
  const surface = processor?.getSurface(segment.surfaceId);
  useEffect(() => {
    if (!surface || !draftKey) return;
    const initial = structuredClone(surface.dataModel.get('/'));
    for (const change of readStoryUiDraft(draftKey)) {
      try {
        surface.dataModel.set(change.path, change.value);
      } catch {
        /* An invalid session draft cannot change the saved surface. */
      }
    }
    const subscription = surface.dataModel.subscribe('/', (value) => {
      writeStoryUiDraft(draftKey, storyUiDraftChanges(initial, value));
    });
    return () => subscription.unsubscribe();
  }, [surface, draftKey]);
  const submit = async () => {
    if (!action || !chatId || !sourceId || !sourceHash || pending) return;
    const identity = JSON.stringify([
      chatId,
      sourceId,
      sourceHash,
      actionBlockId ?? segment.id,
      action.name,
      action.sourceComponentId,
      action.context,
      mode,
    ]);
    const command = commands.get(identity) ?? {
      body: {
        sourceRevision: sourceId,
        sourceHash,
        blockId: actionBlockId ?? segment.id,
        surfaceId: segment.surfaceId,
        eventName: action.name,
        componentId: action.sourceComponentId,
        context: action.context,
        mode,
        idempotencyKey: crypto.randomUUID(),
      },
      uncertain: false,
    };
    commands.set(identity, command);
    setPending(true);
    setFailed(false);
    setFailure(undefined);
    const admitted = beginAdmission?.();
    try {
      const run = await api<Run>(
        `/chats/${encodeURIComponent(chatId)}/story-ui/actions`,
        command.body
      );
      admitted?.(run);
      commands.delete(identity);
      if (draftKey) writeStoryUiDraft(draftKey, []);
      setUncertain(false);
      setAction(undefined);
      try {
        await refresh?.();
      } catch {
        setFailed(true);
      }
    } catch (error) {
      if (error instanceof ApiError) setFailure(error);
      if (definiteRejection(error)) commands.delete(identity);
      else {
        command.uncertain = true;
        setUncertain(true);
      }
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      className="story-ui"
      data-story-ui-style={resolveStoryUiStyle(style, segment.messages)}
    >
      {surface && (
        <div inert={!!action && !!chatId && (latest || uncertain)}>
          <MarkdownContext.Provider value={renderMarkdown}>
            <A2uiSurface surface={surface} />
          </MarkdownContext.Provider>
        </div>
      )}
      {!surface && <p role="status">{t('storyUi.invalid')}</p>}
      {action &&
        ((latest || uncertain) && chatId ? (
          <div className="story-ui-action">
            <label>
              <input
                type="radio"
                checked={mode === 'short'}
                disabled={uncertain || pending}
                onChange={() => setMode('short')}
              />
              {t('storyUi.actionModeShort')}
            </label>
            <label>
              <input
                type="radio"
                checked={mode === 'continue'}
                disabled={uncertain || pending}
                onChange={() => setMode('continue')}
              />
              {t('storyUi.actionModeContinue')}
            </label>
            {failed && <p role="alert">{failure?.displayMessage ?? t('storyUi.failed')}</p>}
            <button type="button" disabled={pending} onClick={() => void submit()}>
              {t('storyUi.send')}
            </button>
            <button
              type="button"
              disabled={pending || uncertain}
              onClick={() => setAction(undefined)}
            >
              {t('shared.cancel')}
            </button>
          </div>
        ) : (
          <p role="status">{t('storyUi.older')}</p>
        ))}
    </section>
  );
}
